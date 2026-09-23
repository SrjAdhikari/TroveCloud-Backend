//* src/controllers/file.controller.js

import {
	getFile,
	createDownloadUrl,
	initiateUpload,
	confirmUpload,
	cancelUpload,
	updateFile,
	deleteFile,
} from "../services/file.service.js";

import httpStatus from "../constants/httpStatus.js";

const { OK, CREATED } = httpStatus;

const getFileHandler = async (req, res) => {
	const user = req.user;
	const fileId = req.params.id;

	const file = await getFile(fileId, user._id);

	return res.status(OK).json({
		success: true,
		message: "File retrieved successfully",
		data: file,
	});
};

const createDownloadUrlHandler = async (req, res) => {
	const user = req.user;
	const fileId = req.params.id;

	const result = await createDownloadUrl(fileId, user._id, {
		download: req.query.action === "download",
	});

	return res.status(OK).json({
		success: true,
		message: "Download URL created successfully",
		data: result,
	});
};

const initiateUploadHandler = async (req, res) => {
	const user = req.user;

	// Body validated and name sanitized by initiateUploadSchema (validateBody).
	const { name, size } = req.body ?? {};

	// If no ID is explicitly requested, default to the user's permanent Root Directory
	const parentDirId = req.params.parentDirId || user.rootDirId.toString();

	const result = await initiateUpload(
		parentDirId,
		user._id,
		name,
		size,
		user.storageLimit,
	);

	return res.status(CREATED).json({
		success: true,
		message: "Upload initiated successfully",
		data: result,
	});
};

const confirmUploadHandler = async (req, res) => {
	const user = req.user;
	const fileId = req.params.id;

	const file = await confirmUpload(fileId, user._id);

	return res.status(OK).json({
		success: true,
		message: "File uploaded successfully",
		data: file,
	});
};

const cancelUploadHandler = async (req, res) => {
	const user = req.user;
	const fileId = req.params.id;

	const cancelledFile = await cancelUpload(fileId, user._id);

	return res.status(OK).json({
		success: true,
		message: "Upload cancelled successfully",
		data: cancelledFile,
	});
};

const updateFileHandler = async (req, res) => {
	const user = req.user;
	const fileId = req.params.id;

	// Name is sanitized and validated by renameFileSchema (validateBody).
	const newFileName = req.body.newFileName;
	const updatedFile = await updateFile(fileId, newFileName, user._id);

	return res.status(OK).json({
		success: true,
		message: "File renamed successfully",
		data: updatedFile,
	});
};

const deleteFileHandler = async (req, res) => {
	const user = req.user;
	const fileId = req.params.id;

	const deletedFile = await deleteFile(fileId, user._id);

	return res.status(OK).json({
		success: true,
		message: "File deleted successfully",
		data: deletedFile,
	});
};

export {
	getFileHandler,
	createDownloadUrlHandler,
	initiateUploadHandler,
	confirmUploadHandler,
	cancelUploadHandler,
	updateFileHandler,
	deleteFileHandler,
};
