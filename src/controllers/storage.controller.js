//* src/controllers/storage.controller.js

import { getStorageUsage } from "../services/storage.service.js";
import httpStatus from "../constants/httpStatus.js";

const { OK } = httpStatus;

export const getStorageUsageHandler = async (req, res) => {
	const userId = req.user._id;
	const totalStorageLimit = req.user.storageLimit;

	const usage = await getStorageUsage(userId, totalStorageLimit);

	return res.status(OK).json({
		success: true,
		message: "Storage usage retrieved successfully",
		data: usage,
	});
};
