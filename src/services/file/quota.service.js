//* src/services/file/quota.service.js

import Directory from "../../models/directory.model.js";

import { settleExpiredPendingFiles } from "./expirySweep.service.js";

import httpStatus from "../../constants/httpStatus.js";
import appErrorCode from "../../constants/appErrorCode.js";
import AppError from "../../errors/AppError.js";

const { BAD_REQUEST, INTERNAL_SERVER_ERROR } = httpStatus;
const { STORAGE_LIMIT_EXCEEDED, INVALID_STORAGE_LIMIT } = appErrorCode;

const isValidStorageLimit = (limit) => Number.isFinite(limit) && limit >= 0;

/** Reads a user's stored bytes from the root directory's denormalized size */
const getStoredBytes = async (userId, session) => {
	const rootDir = await Directory.findOne(
		{ userId, parentDirId: null },
		"size",
		{ session },
	).lean();

	return rootDir?.size ?? 0;
};

const checkQuota = async (userId, bytes, totalStorageLimit, session) => {
	if (!isValidStorageLimit(totalStorageLimit)) {
		throw new AppError(
			"Storage limit is not configured",
			INTERNAL_SERVER_ERROR,
			INVALID_STORAGE_LIMIT,
		);
	}

	if ((await getStoredBytes(userId, session)) + bytes > totalStorageLimit) {
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
 * With `reclaim` off, a quota rejection propagates without the sweep.
 */
const reserveQuotaWithReclaim = async (
	userId,
	reserve,
	{ excludedFileId, reclaim = true } = {},
) => {
	try {
		await reserve();
	} catch (error) {
		if (
			!reclaim ||
			!(error instanceof AppError) ||
			error.code !== STORAGE_LIMIT_EXCEEDED
		) {
			throw error;
		}

		const deletedFiles = await settleExpiredPendingFiles(userId, excludedFileId);
		if (deletedFiles.length === 0) throw error;

		// Exactly one retry: a second rejection propagates unchanged.
		await reserve();
	}
};

export {
	isValidStorageLimit,
	getStoredBytes,
	checkQuota,
	reserveQuotaWithReclaim,
};
