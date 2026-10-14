//* src/services/file/serverUpload.service.js

import mongoose from "mongoose";
import { pipeline } from "node:stream";

import File from "../../models/file.model.js";

import { releaseReservedBytes, removeObject } from "./reservation.service.js";
import { checkQuota, reserveQuotaWithReclaim } from "./quota.service.js";
import { validateAndBuildNewFile } from "./upload.service.js";
import { updateAncestorDirectoryStats } from "../directory.service.js";

import { putObject } from "../../lib/r2.js";
import createByteCounter from "../../utils/byteCounter.js";
import { ONE_HOUR_MS } from "../../utils/date.js";

import envConfig from "../../constants/env.js";
import httpStatus from "../../constants/httpStatus.js";
import appErrorCode from "../../constants/appErrorCode.js";
import AppError from "../../errors/AppError.js";

const { BAD_REQUEST, INTERNAL_SERVER_ERROR } = httpStatus;
const { FILE_UPLOAD_FAILED, FILE_TOO_LARGE } = appErrorCode;

const { MAX_FILE_UPLOAD_SIZE } = envConfig;

const rollbackFailedUpload = async (fileId, parentDirId, objectKey) => {
	// Nothing was reserved but the claim's file count, so the refund is 0 bytes.
	const released = await releaseReservedBytes(fileId, parentDirId, 0);

	// An absent row proves nothing names this key; only a promoted row keeps its object.
	if (released || !(await File.exists({ _id: fileId }))) {
		await removeObject(objectKey, fileId);
	}
};

// Saves an empty upload record before reading any bytes, so every stored file has a record pointing to it.
// Only the file count is reserved here; the bytes are counted once the real size is known.
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

		console.warn(
			`Failed to claim the upload for file ${fileId}: ${error?.name} ${error?.$metadata?.httpStatusCode ?? ""}`.trim(),
		);

		throw new AppError(
			"Failed to upload file",
			INTERNAL_SERVER_ERROR,
			FILE_UPLOAD_FAILED,
		);
	} finally {
		await session.endSession();
	}
};

// Used when the server already holds the file (Drive import).
// Returns the full record, including the storage key, so only call it from server code.
export const uploadFileFromServer = async (
	parentDirId,
	userId,
	fileName,
	fileStream,
	totalStorageLimit,
	{ perFileCap = MAX_FILE_UPLOAD_SIZE, reclaim = true } = {},
) => {
	const newFile = await validateAndBuildNewFile(parentDirId, userId, fileName);
	const { parentDir, fileId, objectKey, contentType } = newFile;

	await createUploadClaim(newFile, userId, fileName);

	const byteCounter = createByteCounter(perFileCap);
	const countedStream = pipeline(fileStream, byteCounter.stream, () => {});

	try {
		await putObject(objectKey, countedStream, { contentType });
	} catch (error) {
		await rollbackFailedUpload(fileId, parentDir._id, objectKey);

		if (byteCounter.state.tripped) {
			throw new AppError(
				"File exceeds upload size cap",
				BAD_REQUEST,
				FILE_TOO_LARGE,
			);
		}

		console.warn(
			`Failed to store the upload for file ${fileId}: ${error?.name} ${error?.$metadata?.httpStatusCode ?? ""}`.trim(),
		);

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
		await reserveQuotaWithReclaim(userId, reserveQuota, {
			excludedFileId: fileId,
			reclaim,
		});
	} catch (error) {
		await rollbackFailedUpload(fileId, parentDir._id, objectKey);

		if (error instanceof AppError) throw error;

		console.warn(
			`Failed to finalize the upload for file ${fileId}: ${error?.name} ${error?.$metadata?.httpStatusCode ?? ""}`.trim(),
		);

		throw new AppError(
			"Failed to upload file",
			INTERNAL_SERVER_ERROR,
			FILE_UPLOAD_FAILED,
		);
	}

	return file;
};
