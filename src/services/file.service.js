//* src/services/file.service.js

import mongoose from "mongoose";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream";

import File from "../models/file.model.js";
import Directory from "../models/directory.model.js";

import { updateAncestorDirectoryStats } from "./directory.service.js";

import {
	buildFileKey,
	presignPut,
	presignGet,
	getObjectMetadata,
	putObject,
	deleteObject,
	UPLOAD_URL_TTL_SECONDS,
	DOWNLOAD_URL_TTL_SECONDS,
} from "../lib/r2.js";
import createByteCounter from "../utils/byteCounter.js";
import { mimeFromExtension, isInlineSafe } from "../utils/mimeType.js";
import {
	FIFTEEN_MINUTES_MS,
	ONE_HOUR_MS,
	ONE_MINUTE_MS,
} from "../utils/date.js";

import envConfig from "../constants/env.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import AppError from "../errors/AppError.js";

const { NOT_FOUND, BAD_REQUEST, CONFLICT, INTERNAL_SERVER_ERROR } = httpStatus;
const {
	FILE_NOT_FOUND,
	DIRECTORY_NOT_FOUND,
	FILE_UPLOAD_FAILED,
	FILE_TOO_LARGE,
	STORAGE_LIMIT_EXCEEDED,
	INVALID_STORAGE_LIMIT,
	INVALID_INPUT,
	UPLOAD_INCOMPLETE,
	UPLOAD_OBJECT_MISMATCH,
	UPLOAD_ALREADY_CONFIRMED,
	UPLOAD_IN_PROGRESS,
	UPLOAD_CANCELLED,
} = appErrorCode;

const { MAX_FILE_UPLOAD_SIZE } = envConfig;

const MIN_UPLOAD_BYTES_PER_SECOND = 16_000;
const MAX_EXPIRED_FILES_PER_SWEEP = 25;

const isValidStorageLimit = (limit) =>
	Number.isFinite(limit) || limit === Number.POSITIVE_INFINITY;

const isUploadStillLive = (file) =>
	file.status !== "ready" &&
	(!file.uploadExpiresAt || file.uploadExpiresAt > new Date());

/** Calculates the expiry time for a pending upload based on the declared size and minimum upload speed */
const calculateUploadExpiry = (declaredSize) => {
	const transferMs = (declaredSize / MIN_UPLOAD_BYTES_PER_SECOND) * 1000;

	return new Date(
		Date.now() +
			UPLOAD_URL_TTL_SECONDS * 1000 +
			Math.min(ONE_HOUR_MS, Math.max(FIFTEEN_MINUTES_MS, transferMs)),
	);
};

/**
 * Releases the reserved bytes for a pending upload, and deletes its row if it is still pending.
 * Returns true if the row was deleted, false if it was already gone or not pending.
 */
const releaseReservedBytes = async (fileId, parentDirId, bytes) => {
	const mongooseSession = await mongoose.startSession();
	let released = false;

	try {
		await mongooseSession.withTransaction(async () => {
			released = false;

			const { deletedCount } = await File.deleteOne(
				{ _id: fileId, status: "pending" },
				{ session: mongooseSession },
			);

			if (deletedCount === 1) {
				await updateAncestorDirectoryStats(
					parentDirId,
					{ bytes: -bytes, files: -1 },
					mongooseSession,
				);
				released = true;
			}
		});
	} catch (error) {
		console.warn(
			`Failed to release the reservation for file ${fileId}: ${error.name} ${error.code ?? ""}`.trim(),
		);
	} finally {
		await mongooseSession.endSession();
	}

	return released;
};

const matchSizeAndType = (fileMetadata, file) =>
	Boolean(fileMetadata) &&
	fileMetadata.size === file.size &&
	fileMetadata.contentType === file.contentType;

const findExpiredFiles = async (userId, excludedFileId) => {
	const filter = {
		userId,
		status: "pending",
		uploadExpiresAt: { $lt: new Date() },
	};

	if (excludedFileId) filter._id = { $ne: excludedFileId };

	return File.find(filter, "parentDirId size objectKey contentType")
		.limit(MAX_EXPIRED_FILES_PER_SWEEP)
		.lean();
};

/** Classifies expired files by checking if their objects exist and match the expected size and type */
const classifyExpiredObjects = async (files) => {
	const outcomes = await Promise.all(
		files.map(async (file) => {
			try {
				const fileMetadata = await getObjectMetadata(file.objectKey);

				return [
					String(file._id),
					matchSizeAndType(fileMetadata, file) ? "present" : "absent",
				];
			} catch (error) {
				console.warn(
					`Failed to look up the object for file ${file._id}: ${error.name} ${error.$metadata?.httpStatusCode ?? ""}`.trim(),
				);

				return [String(file._id), "unknown"];
			}
		}),
	);

	return new Map(outcomes);
};

/** Promotes or refunds expired files based on their classification */
const promoteOrRefundExpiredFiles = async (
	expiredFiles,
	objectOutcomes,
	userId,
	session,
) => {
	const deletedFiles = [];

	for (const file of expiredFiles) {
		const outcome = objectOutcomes.get(String(file._id)) ?? "unknown";

		if (outcome === "present") {
			await File.updateOne(
				{ _id: file._id, userId, status: "pending" },
				{
					$set: { status: "ready" },
					$unset: { uploadExpiresAt: "", cancelledAt: "" },
				},
				{ session },
			);
			continue;
		}

		if (outcome === "unknown") continue;

		const { deletedCount } = await File.deleteOne(
			{ _id: file._id, userId, status: "pending" },
			{ session },
		);

		if (deletedCount !== 1) continue;

		await updateAncestorDirectoryStats(
			file.parentDirId,
			{ bytes: -file.size, files: -1 },
			session,
		);
		deletedFiles.push(file);
	}

	return deletedFiles;
};

/** Releases expired files for a user, excluding a specific file if provided */
const releaseExpiredFiles = async (userId, excludedFileId) => {
	let deletedFiles = [];

	try {
		const expiredFiles = await findExpiredFiles(userId, excludedFileId);
		if (expiredFiles.length === 0) return deletedFiles;

		const objectOutcomes = await classifyExpiredObjects(expiredFiles);
		const mongooseSession = await mongoose.startSession();

		try {
			await mongooseSession.withTransaction(async () => {
				deletedFiles = await promoteOrRefundExpiredFiles(
					expiredFiles,
					objectOutcomes,
					userId,
					mongooseSession,
				);
			});
		} finally {
			await mongooseSession.endSession();
		}
	} catch (error) {
		// An aborted sweep rolls the rows back, so a stale list would drop objects still named by live rows.
		deletedFiles = [];
		console.warn(
			`Failed to release expired uploads for user ${userId}: ${error.name} ${error.code ?? ""}`.trim(),
		);
	}

	return deletedFiles;
};

const removeObject = async (objectKey, fileId) => {
	try {
		await deleteObject(objectKey);
	} catch (error) {
		console.warn(
			`Failed to remove the object for file ${fileId}: ${error.name} ${error.$metadata?.httpStatusCode ?? ""}`.trim(),
		);
	}
};

/** Rolls back a failed upload by releasing its reserved bytes and deleting its object if no row names it */
const rollbackFailedUpload = async (fileId, parentDirId, objectKey) => {
	// Nothing was reserved but the claim's file count, so the refund is 0 bytes.
	const released = await releaseReservedBytes(fileId, parentDirId, 0);

	// An absent row proves nothing names this key; only a promoted row keeps its object.
	if (released || !(await File.exists({ _id: fileId }))) {
		await removeObject(objectKey, fileId);
	}
};

const checkQuota = async (userId, bytes, totalStorageLimit, session) => {
	if (!isValidStorageLimit(totalStorageLimit)) {
		throw new AppError(
			"Storage limit is not configured",
			INTERNAL_SERVER_ERROR,
			INVALID_STORAGE_LIMIT,
		);
	}

	const rootDir = await Directory.findOne(
		{ userId, parentDirId: null },
		"size",
		{ session },
	).lean();

	if ((rootDir?.size ?? 0) + bytes > totalStorageLimit) {
		throw new AppError(
			"Storage limit exceeded",
			BAD_REQUEST,
			STORAGE_LIMIT_EXCEEDED,
		);
	}
};

/**
 * Attempts to reserve quota for a new file, and reclaims expired files if the attempt fails. 
 * If that frees up enough space, it is retried once. A second failure propagates unchanged.
 */
const reserveQuotaWithReclaim = async (userId, reserve, excludedFileId) => {
	try {
		await reserve();
	} catch (error) {
		if (!(error instanceof AppError) || error.code !== STORAGE_LIMIT_EXCEEDED) {
			throw error;
		}

		const deletedFiles = await releaseExpiredFiles(userId, excludedFileId);
		if (deletedFiles.length === 0) throw error;

		await Promise.allSettled(
			deletedFiles.map((file) => removeObject(file.objectKey, file._id)),
		);

		// Exactly one retry: a second rejection propagates unchanged.
		await reserve();
	}
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
	const extension = path.extname(fileName).toLowerCase();
	if (!/^\.[a-z0-9]+$/.test(extension)) {
		throw new AppError(
			"File name must end in a simple extension",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

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
 * Writes the 0-byte pending row that claims the key before any bytes are read,
 * so no object can exist without a row naming it. Only the file count is
 * reserved here; the streamed bytes are counted once they are known.
 */
const createUploadClaim = async (
	{ parentDir, extension, fileId, objectKey, contentType },
	userId,
	fileName,
) => {
	const session = await mongoose.startSession();

	try {
		await session.withTransaction(async () => {
			await File.create(
				[
					{
						_id: fileId,
						name: fileName,
						extension,
						contentType,
						size: 0,
						parentDirId: parentDir._id,
						userId,
						status: "pending",
						uploadExpiresAt: new Date(Date.now() + ONE_HOUR_MS),
						objectKey,
					},
				],
				{ session },
			);

			await updateAncestorDirectoryStats(
				parentDir._id,
				{ bytes: 0, files: 1 },
				session,
			);
		});
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError(
			"Failed to upload file",
			INTERNAL_SERVER_ERROR,
			FILE_UPLOAD_FAILED,
		);
	} finally {
		await session.endSession();
	}
};

/**
 * Uploads a file from a server-held stream — Drive import and the cutover
 * script, where the bytes reach the server first so a presigned PUT is not an
 * option. Returns the raw document, key included: every caller is server-side.
 *
 * @param {string} parentDirId - The ID of the target parent directory
 * @param {string} userId - The owner's ID, for the ownership check
 * @param {string} fileName - The sanitized filename provided by the caller
 * @param {import("node:stream").Readable} fileStream - The bytes to store
 * @param {number} totalStorageLimit - Quota in bytes. Pass
 *   `Number.POSITIVE_INFINITY` to declare an exemption (issue #65)
 * @param {number} [perFileCap=MAX_FILE_UPLOAD_SIZE] - Per-file byte ceiling
 *
 * @returns {Promise<Object>} The newly created file document (lean)
 * @throws {AppError} Unknown parent, bad extension, quota exceeded, or upload failure
 */
const uploadFileFromServer = async (
	parentDirId,
	userId,
	fileName,
	fileStream,
	totalStorageLimit,
	perFileCap = MAX_FILE_UPLOAD_SIZE,
) => {
	const newFile = await validateAndBuildNewFile(parentDirId, userId, fileName);
	const { parentDir, fileId, objectKey, contentType } = newFile;

	await createUploadClaim(newFile, userId, fileName);

	const byteCounter = createByteCounter(perFileCap);
	const countedStream = pipeline(fileStream, byteCounter.stream, () => {});

	try {
		await putObject(objectKey, countedStream, { contentType });
	} catch {
		await rollbackFailedUpload(fileId, parentDir._id, objectKey);

		if (byteCounter.state.tripped) {
			throw new AppError(
				"File exceeds upload size cap",
				BAD_REQUEST,
				FILE_TOO_LARGE,
			);
		}

		throw new AppError(
			"Failed to upload file",
			INTERNAL_SERVER_ERROR,
			FILE_UPLOAD_FAILED,
		);
	}

	const bytes = byteCounter.state.bytes;
	let file;

	const reserveQuota = async () => {
		const mongooseSession = await mongoose.startSession();
		try {
			await mongooseSession.withTransaction(async () => {
				await checkQuota(userId, bytes, totalStorageLimit, mongooseSession);

				file = await File.findOneAndUpdate(
					{ _id: fileId, status: "pending" },
					{
						$set: { status: "ready", size: bytes },
						$unset: { uploadExpiresAt: "" },
					},
					{ new: true, session: mongooseSession },
				)
					.select("+objectKey")
					.lean();

				if (!file) {
					throw new AppError(
						"Failed to upload file",
						INTERNAL_SERVER_ERROR,
						FILE_UPLOAD_FAILED,
					);
				}

				await updateAncestorDirectoryStats(
					parentDir._id,
					{ bytes },
					mongooseSession,
				);
			});
		} finally {
			await mongooseSession.endSession();
		}
	};

	try {
		await reserveQuotaWithReclaim(userId, reserveQuota, fileId);
	} catch (error) {
		await rollbackFailedUpload(fileId, parentDir._id, objectKey);

		if (error instanceof AppError) throw error;
		throw new AppError(
			"Failed to upload file",
			INTERNAL_SERVER_ERROR,
			FILE_UPLOAD_FAILED,
		);
	}

	return file;
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
	} catch {
		await releaseReservedBytes(fileId, parentDir._id, declaredSize);

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
 * Cancels a pending upload, releasing its reserved bytes and shortening its upload window
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
	MIN_UPLOAD_BYTES_PER_SECOND,
	MAX_EXPIRED_FILES_PER_SWEEP,
	getFile,
	createDownloadUrl,
	uploadFileFromServer,
	updateFile,
	deleteFile,
	initiateUpload,
	confirmUpload,
	cancelUpload,
};
