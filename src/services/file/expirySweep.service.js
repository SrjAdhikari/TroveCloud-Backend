//* src/services/file/expirySweep.service.js

import mongoose from "mongoose";

import File from "../../models/file.model.js";

import { matchSizeAndType, removeObject } from "./reservation.service.js";
import { updateAncestorDirectoryStats } from "../directory.service.js";

import { getObjectMetadata } from "../../lib/r2.js";

const MAX_EXPIRED_FILES_PER_SWEEP = 25;

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

/** Settles a user's expired reservations and removes the objects of the refunded rows */
const settleExpiredPendingFiles = async (userId, excludedFileId) => {
	const deletedFiles = await releaseExpiredFiles(userId, excludedFileId);

	await Promise.allSettled(
		deletedFiles.map((file) => removeObject(file.objectKey, file._id)),
	);

	return deletedFiles;
};

export {
	MAX_EXPIRED_FILES_PER_SWEEP,
	settleExpiredPendingFiles,
};
