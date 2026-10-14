//* src/controllers/directory.controller.js

import {
	getDirectory,
	createDirectory,
	updateDirectory,
	deleteDirectory,
} from "../services/directory.service.js";
import httpStatus from "../constants/httpStatus.js";

const { OK, CREATED } = httpStatus;

export const getDirectoryHandler = async (req, res) => {
	const user = req.user;

	// If no ID is explicitly requested, default to the user's permanent Root Directory
	const directoryId = req.params.id || user.rootDirId.toString();

	const directoryData = await getDirectory(directoryId, user._id);

	return res.status(OK).json({
		success: true,
		message: "Directory fetched successfully",
		data: directoryData,
	});
};

export const createDirectoryHandler = async (req, res) => {
	const user = req.user;

	// Name is sanitized and defaulted by createDirectorySchema (validateBody).
	const dirname = req.body.name;

	// If no ID is explicitly requested, default to the user's permanent Root Directory
	const parentDirId = req.params.parentDirId || user.rootDirId.toString();

	const newDirectory = await createDirectory(parentDirId, dirname, user._id);

	return res.status(CREATED).json({
		success: true,
		message: "Directory created successfully",
		data: newDirectory,
	});
};

export const updateDirectoryHandler = async (req, res) => {
	const user = req.user;
	const directoryId = req.params.id;

	// Name is sanitized and validated by renameDirectorySchema (validateBody).
	const newDirName = req.body.newDirName;

	const updatedDirectory = await updateDirectory(
		directoryId,
		newDirName,
		user._id,
	);

	return res.status(OK).json({
		success: true,
		message: "Directory renamed successfully",
		data: updatedDirectory,
	});
};

export const deleteDirectoryHandler = async (req, res) => {
	const user = req.user;
	const directoryId = req.params.id;

	const deletedDirectory = await deleteDirectory(directoryId, user._id);

	return res.status(OK).json({
		success: true,
		message: "Directory deleted successfully",
		data: deletedDirectory,
	});
};
