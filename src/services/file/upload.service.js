//* src/services/file/upload.service.js

import mongoose from "mongoose";
import path from "node:path";
import { randomBytes } from "node:crypto";

import File from "../../models/file.model.js";
import Directory from "../../models/directory.model.js";

import {
	calculateUploadExpiry,
	releaseReservedBytes,
	matchSizeAndType,
} from "./reservation.service.js";
import { checkQuota, reserveQuotaWithReclaim } from "./quota.service.js";
import { updateAncestorDirectoryStats } from "../directory.service.js";

import {
	buildFileKey,
	presignPut,
	getObjectMetadata,
	UPLOAD_URL_TTL_SECONDS,
} from "../../lib/r2.js";
import { mimeFromExtension } from "../../utils/mimeType.js";
import { ONE_MINUTE_MS } from "../../utils/date.js";

import envConfig from "../../constants/env.js";
import httpStatus from "../../constants/httpStatus.js";
import appErrorCode from "../../constants/appErrorCode.js";
import AppError from "../../errors/AppError.js";

const { NOT_FOUND, BAD_REQUEST, CONFLICT, INTERNAL_SERVER_ERROR } = httpStatus;
const {
	FILE_NOT_FOUND,
	DIRECTORY_NOT_FOUND,
	FILE_UPLOAD_FAILED,
	FILE_TOO_LARGE,
	INVALID_INPUT,
	UPLOAD_INCOMPLETE,
	UPLOAD_OBJECT_MISMATCH,
	UPLOAD_ALREADY_CONFIRMED,
	UPLOAD_CANCELLED,
} = appErrorCode;

const { MAX_FILE_UPLOAD_SIZE } = envConfig;

/**
 * Rejects a name that does not end in a simple extension. Callers that fetch
 * the bytes from elsewhere run it first, so a bad name never opens a transfer.
 *
 * @param {string} fileName - The sanitized filename provided by the caller
 *
 * @returns {string} The lowercased extension, dot included
 * @throws {AppError} If the name has no simple extension
 */
const assertUploadableFileName = (fileName) => {
	const extension = path.extname(fileName).toLowerCase();
	if (!/^\.[a-z0-9]+$/.test(extension)) {
		throw new AppError(
			"File name must end in a simple extension",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	return extension;
};

/**
 * Verifies the parent directory belongs to the user and creates the new
 * file's identity. Shared by both upload paths so they cannot drift apart.
 *
 * @param {string} parentDirId - The ID of the target parent directory
 * @param {string} userId - The owner's ID, for the ownership check
 * @param {string} fileName - The sanitized filename provided by the caller
 *
 * @returns {Promise<{parentDir: Object, extension: string,
 *   fileId: import("mongoose").Types.ObjectId, objectKey: string, contentType: string}>}
 * @throws {AppError} Bad extension, or a parent the user does not own
 */
const validateAndBuildNewFile = async (parentDirId, userId, fileName) => {
	const extension = assertUploadableFileName(fileName);

	const parentDir = await Directory.findOne({
		_id: parentDirId,
		userId,
	}).lean();

	if (!parentDir) {
		throw new AppError(
			"Parent directory not found",
			NOT_FOUND,
			DIRECTORY_NOT_FOUND,
		);
	}

	const fileId = new mongoose.Types.ObjectId();

	return {
		parentDir,
		extension,
		fileId,
		objectKey: buildFileKey(
			fileId.toString(),
			randomBytes(16).toString("hex"),
			extension,
		),
		contentType: mimeFromExtension(extension),
	};
};

/**
 * Mints a presigned PUT and reserves the declared bytes against the quota.
 *
 * @param {string} parentDirId - The ID of the target parent directory
 * @param {string} userId - The owner's ID, for the ownership check
 * @param {string} fileName - The sanitized filename provided by the user
 * @param {number} declaredSize - The byte length the client promises to upload
 * @param {number} totalStorageLimit - The user's quota in bytes (from req.user)
 *
 * @returns {Promise<{fileId: string, uploadUrl: string, contentType: string,
 *   expiresAt: Date, uploadExpiresAt: Date}>} `expiresAt` is the URL TTL;
 *   `uploadExpiresAt` is when the pending upload is given up on
 * @throws {AppError} Bad or oversized size, unknown parent, or quota exceeded
 */
const initiateUpload = async (
	parentDirId,
	userId,
	fileName,
	declaredSize,
	totalStorageLimit,
) => {
	if (!Number.isInteger(declaredSize) || declaredSize <= 0) {
		throw new AppError("Invalid file size", BAD_REQUEST, INVALID_INPUT);
	}

	if (declaredSize > MAX_FILE_UPLOAD_SIZE) {
		throw new AppError(
			"File exceeds upload size cap",
			BAD_REQUEST,
			FILE_TOO_LARGE,
		);
	}

	const { parentDir, extension, fileId, objectKey, contentType } =
		await validateAndBuildNewFile(parentDirId, userId, fileName);

	const uploadExpiresAt = calculateUploadExpiry(declaredSize);

	const reserveQuota = async () => {
		const mongooseSession = await mongoose.startSession();
		try {
			await mongooseSession.withTransaction(async () => {
				await checkQuota(
					userId,
					declaredSize,
					totalStorageLimit,
					mongooseSession,
				);

				await File.create(
					[
						{
							_id: fileId,
							name: fileName,
							extension,
							contentType,
							size: declaredSize,
							parentDirId: parentDir._id,
							userId,
							status: "pending",
							uploadExpiresAt,
							objectKey,
						},
					],
					{ session: mongooseSession },
				);

				await updateAncestorDirectoryStats(
					parentDir._id,
					{ bytes: declaredSize, files: 1 },
					mongooseSession,
				);
			});
		} finally {
			await mongooseSession.endSession();
		}
	};

	await reserveQuotaWithReclaim(userId, reserveQuota);

	let uploadUrl;
	try {
		uploadUrl = await presignPut(objectKey, {
			contentType,
			contentLength: declaredSize,
		});
	} catch (error) {
		await releaseReservedBytes(fileId, parentDir._id, declaredSize);

		console.warn(
			`Failed to presign the upload for file ${fileId}: ${error.name} ${error.$metadata?.httpStatusCode ?? ""}`.trim(),
		);

		throw new AppError(
			"Failed to start the upload",
			INTERNAL_SERVER_ERROR,
			FILE_UPLOAD_FAILED,
		);
	}

	return {
		fileId: fileId.toString(),
		uploadUrl,
		contentType,
		expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000),
		uploadExpiresAt,
	};
};

/**
 * Confirms that a presigned PUT completed successfully, and promotes the
 * file from a pending upload to a real file. Until it is called the declared
 * bytes stay reserved against the owner's quota (see issue #86).
 *
 * @param {string} fileId - The ID of the pending file
 * @param {string} userId - The owner's ID, for the ownership check
 *
 * @returns {Promise<Object>} The ready file document
 * @throws {AppError} FILE_NOT_FOUND | UPLOAD_INCOMPLETE | UPLOAD_OBJECT_MISMATCH | UPLOAD_ALREADY_CONFIRMED | UPLOAD_CANCELLED
 */
const confirmUpload = async (fileId, userId) => {
	const file = await File.findOne({ _id: fileId, userId })
		.select("+objectKey")
		.lean();

	if (!file) {
		throw new AppError("File not found", NOT_FOUND, FILE_NOT_FOUND);
	}

	const { objectKey, ...fileForResponse } = file;

	const fileMetadata = await getObjectMetadata(objectKey);
	const matches = matchSizeAndType(fileMetadata, file);

	if (file.status === "ready") {
		if (matches) return fileForResponse;

		throw new AppError(
			"This upload has already been completed.",
			BAD_REQUEST,
			UPLOAD_ALREADY_CONFIRMED,
		);
	}

	if (!fileMetadata) {
		throw new AppError(
			"The upload didn't finish. Please try again.",
			BAD_REQUEST,
			UPLOAD_INCOMPLETE,
		);
	}

	if (!matches) {
		throw new AppError(
			"The uploaded file doesn't match what was requested. Please try uploading again.",
			BAD_REQUEST,
			UPLOAD_OBJECT_MISMATCH,
		);
	}

	const updatedFile = await File.findOneAndUpdate(
		{ _id: file._id, status: "pending", cancelledAt: { $exists: false } },
		{ $set: { status: "ready" }, $unset: { uploadExpiresAt: "" } },
		{ new: true },
	).lean();

	if (!updatedFile) {
		const existingFile = await File.findById(file._id).lean();

		if (!existingFile) {
			throw new AppError("File not found", NOT_FOUND, FILE_NOT_FOUND);
		}

		if (existingFile.cancelledAt) {
			throw new AppError(
				"This upload was cancelled. Please start a new upload.",
				CONFLICT,
				UPLOAD_CANCELLED,
			);
		}

		return existingFile;
	}

	return updatedFile;
};

/**
 * Cancels a pending upload by shortening its window and marking it cancelled; the sweep refunds the bytes and drops the object
 *
 * @param {string} fileId - The ID of the pending file
 * @param {string} userId - The owner's ID, for the ownership check
 *
 * @returns {Promise<Object>} The cancelled file document
 * @throws {AppError} FILE_NOT_FOUND | UPLOAD_ALREADY_CONFIRMED
 */
const cancelUpload = async (fileId, userId) => {
	const file = await File.findOne({ _id: fileId, userId }).lean();

	if (!file) {
		throw new AppError("File not found", NOT_FOUND, FILE_NOT_FOUND);
	}

	if (file.status !== "pending") {
		throw new AppError(
			"This upload has already been completed.",
			BAD_REQUEST,
			UPLOAD_ALREADY_CONFIRMED,
		);
	}

	const shortenedExpiry = new Date(
		file.createdAt.getTime() + UPLOAD_URL_TTL_SECONDS * 1000 + ONE_MINUTE_MS,
	);

	// $min only ever moves the deadline earlier, so a repeated or late cancel cannot extend the file's window.
	const cancelledFile = await File.findOneAndUpdate(
		{ _id: file._id, userId, status: "pending" },
		{
			$min: { uploadExpiresAt: shortenedExpiry },
			$set: { cancelledAt: new Date() },
		},
		{ new: true },
	).lean();

	if (!cancelledFile) {
		throw new AppError(
			"This upload has already been completed.",
			BAD_REQUEST,
			UPLOAD_ALREADY_CONFIRMED,
		);
	}

	return cancelledFile;
};

export {
	assertUploadableFileName,
	validateAndBuildNewFile,
	initiateUpload,
	confirmUpload,
	cancelUpload,
};
