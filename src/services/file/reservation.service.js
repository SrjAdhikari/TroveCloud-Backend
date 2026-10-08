//* src/services/file/reservation.service.js

import mongoose from "mongoose";

import File from "../../models/file.model.js";

import { updateAncestorDirectoryStats } from "../directory.service.js";

import { deleteObject, UPLOAD_URL_TTL_SECONDS } from "../../lib/r2.js";
import { FIFTEEN_MINUTES_MS, ONE_HOUR_MS } from "../../utils/date.js";

const MIN_UPLOAD_BYTES_PER_SECOND = 16_000;

// Shortest and longest time an upload is given to finish, on top of the upload link's lifetime.
const UPLOAD_WINDOW_MS = FIFTEEN_MINUTES_MS;
const UPLOAD_WINDOW_MAX_MS = ONE_HOUR_MS;

// The maximum time a pending upload can be reserved against the user's quota.
const MAX_UPLOAD_RESERVATION_MS = UPLOAD_URL_TTL_SECONDS * 1000 + UPLOAD_WINDOW_MAX_MS;

const isUploadStillLive = (file) =>
	file.status !== "ready" &&
	(!file.uploadExpiresAt || file.uploadExpiresAt > new Date());

/** Calculates the expiry time for a pending upload based on the declared size and minimum upload speed */
const calculateUploadExpiry = (declaredSize) => {
	const transferMs = (declaredSize / MIN_UPLOAD_BYTES_PER_SECOND) * 1000;

	return new Date(
		Date.now() +
			UPLOAD_URL_TTL_SECONDS * 1000 +
			Math.min(UPLOAD_WINDOW_MAX_MS, Math.max(UPLOAD_WINDOW_MS, transferMs)),
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

const removeObject = async (objectKey, fileId) => {
	try {
		await deleteObject(objectKey);
	} catch (error) {
		console.warn(
			`Failed to remove the object for file ${fileId}: ${error.name} ${error.$metadata?.httpStatusCode ?? ""}`.trim(),
		);
	}
};

export {
	MIN_UPLOAD_BYTES_PER_SECOND,
	MAX_UPLOAD_RESERVATION_MS,
	UPLOAD_WINDOW_MS,
	UPLOAD_WINDOW_MAX_MS,
	isUploadStillLive,
	calculateUploadExpiry,
	releaseReservedBytes,
	matchSizeAndType,
	removeObject,
};
