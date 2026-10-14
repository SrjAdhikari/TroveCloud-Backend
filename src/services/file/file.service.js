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

// Gets a file the user owns.
// Unfinished uploads are skipped: they only hold storage space and aren't real files yet.
export const getFile = async (fileId, userId) => {
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

export const createDownloadUrl = async (fileId, userId, options = {}) => {
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

export const updateFile = async (fileId, newFileName, userId) => {
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

export const deleteFile = async (fileId, userId) => {
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
