//* src/services/file/file.service.js

import mongoose from "mongoose";
import path from "node:path";

import File from "../../models/file.model.js";

import { isUploadStillLive, removeObject } from "./reservation.service.js";
import { updateAncestorDirectoryStats } from "../directory.service.js";

import { presignGet, DOWNLOAD_URL_TTL_SECONDS } from "../../lib/r2.js";
import { isInlineSafe } from "../../utils/mimeType.js";

import httpStatus from "../../constants/httpStatus.js";
import appErrorCode from "../../constants/appErrorCode.js";
import AppError from "../../errors/AppError.js";

const { NOT_FOUND, CONFLICT } = httpStatus;
const { FILE_NOT_FOUND, UPLOAD_IN_PROGRESS } = appErrorCode;

const normalizeFileName = (file) => {
	const named = path.extname(file.name);
	if (named.toLowerCase() === file.extension) return file.name;

	return `${path.basename(file.name, named)}${file.extension}`;
};

/**
 * Retrieves a ready file owned by the user. A pending upload is quota
 * bookkeeping, not a file the user has, so it stays invisible here.
 *
 * @param {string} fileId - The ID of the file to fetch
 * @param {string} userId - The owner's ID, for the ownership check
 *
 * @returns {Promise<Object>} The file document
 * @throws {AppError} If the file does not exist or the user does not own it
 */
const getFile = async (fileId, userId) => {
	const file = await File.findOne({
		_id: fileId,
		userId,
		status: "ready",
	}).lean();

	if (!file) {
		throw new AppError("File not found", NOT_FOUND, FILE_NOT_FOUND);
	}

	return file;
};

/**
 * Mints a short-lived signed GET for a file's bytes.
 *
 * @param {string} fileId - The ID of the file to read
 * @param {string} userId - The owner's ID, for the ownership check
 * @param {{ download?: boolean }} [options] - `download` forces an attachment
 *
 * @returns {Promise<{url: string, expiresAt: Date}>} Signed URL and its expiry
 * @throws {AppError} If the file does not exist or the user does not own it
 */
const createDownloadUrl = async (fileId, userId, options = {}) => {
	const file = await File.findOne({ _id: fileId, userId, status: "ready" })
		.select("+objectKey")
		.lean();

	if (!file) {
		throw new AppError("File not found", NOT_FOUND, FILE_NOT_FOUND);
	}

	const shouldServeInline = !options.download && isInlineSafe(file.contentType);

	const url = await presignGet(file.objectKey, {
		contentType: file.contentType,
		fileName: normalizeFileName(file),
		inline: shouldServeInline,
	});

	return {
		url,
		expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000),
	};
};

/**
 * Rename a file owned by the authenticated user.
 *
 * @param {string} fileId - The ID of the file to rename
 * @param {string} newFileName - The new name for the file
 * @param {string} userId - The owner's ID, for the ownership check
 *
 * @returns {Promise<Object>} The updated file document
 * @throws {AppError} Missing, still a pending upload, or not owned by the user
 */
const updateFile = async (fileId, newFileName, userId) => {
	const updatedFile = await File.findOneAndUpdate(
		{ _id: fileId, userId, status: "ready" },
		{ name: newFileName },
		{ new: true, runValidators: true },
	).lean();

	if (!updatedFile) {
		throw new AppError("File not found", NOT_FOUND, FILE_NOT_FOUND);
	}

	return updatedFile;
};

/**
 * Deletes a file's DB record and its stored object.
 *
 * @param {string} fileId - The ID of the file to delete
 * @param {string} userId - The owner's ID, for the ownership check
 *
 * @returns {Promise<Object>} The deleted file document
 * @throws {AppError} Missing, still uploading, or not owned by the user
 */
const deleteFile = async (fileId, userId) => {
	const file = await File.findOne({ _id: fileId, userId })
		.select("+objectKey")
		.lean();

	if (!file) {
		throw new AppError("File not found", NOT_FOUND, FILE_NOT_FOUND);
	}

	const { objectKey, ...responseFile } = file;

	if (isUploadStillLive(file)) {
		throw new AppError(
			"Upload in progress; this file cannot be deleted yet",
			CONFLICT,
			UPLOAD_IN_PROGRESS,
		);
	}

	const mongooseSession = await mongoose.startSession();
	try {
		await mongooseSession.withTransaction(async () => {
			const { deletedCount } = await File.deleteOne(
				{ _id: fileId, userId },
				{ session: mongooseSession },
			);

			if (deletedCount === 1) {
				await updateAncestorDirectoryStats(
					file.parentDirId,
					{ bytes: -file.size, files: -1 },
					mongooseSession,
				);
			}
		});
	} finally {
		await mongooseSession.endSession();
	}

	await removeObject(objectKey, file._id);

	return responseFile;
};

export {
	getFile,
	createDownloadUrl,
	updateFile,
	deleteFile,
};
