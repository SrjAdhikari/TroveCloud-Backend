//* src/services/storage.service.js

import Directory from "../models/directory.model.js";
import File from "../models/file.model.js";
import { settleExpiredPendingFiles } from "./file/expirySweep.service.js";

import {
	categorizeExtension,
	CATEGORY_ICONS,
} from "../utils/fileCategories.js";

// Reads usage from the root folder's total so it always matches the quota check.
export const getStorageUsage = async (userId, totalStorageLimit) => {
	await settleExpiredPendingFiles(userId);

	const rootDir = await Directory.findOne({ userId, parentDirId: null })
		.select("size")
		.lean();

	const usedBytes = rootDir?.size ?? 0;
	const files = await File.find({ userId, status: "ready" })
		.select("extension size")
		.lean();

	// Aggregate total size by category using the extension categorization utility
	const sizeByCategory = files.reduce((acc, file) => {
		const category = categorizeExtension(file.extension);
		acc[category] = (acc[category] ?? 0) + file.size;
		return acc;
	}, {});

	// Convert the category-size mapping into a sorted array with icons for the response
	const breakdown = Object.entries(sizeByCategory)
		.map(([category, size]) => ({
			category,
			size,
			icon: CATEGORY_ICONS[category],
		}))
		.sort((a, b) => b.size - a.size);

	return { used: usedBytes, total: totalStorageLimit, breakdown };
};
