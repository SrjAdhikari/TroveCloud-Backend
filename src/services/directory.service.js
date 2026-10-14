//* src/services/directory.service.js

import mongoose from "mongoose";
import Directory from "../models/directory.model.js";
import File from "../models/file.model.js";
import AppError from "../errors/AppError.js";
import { removeObjects } from "./file/objectCleanup.service.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import { generateBreadCrumb, generatePath } from "../utils/path.js";

const { NOT_FOUND, BAD_REQUEST, CONFLICT } = httpStatus;
const {
	DIRECTORY_NOT_FOUND,
	DIRECTORY_RENAME_FAILED,
	DIRECTORY_DELETE_FAILED,
	UPLOAD_IN_PROGRESS,
} = appErrorCode;

// Name shown to users for their top folder, which is saved as `root-<email>`.
const ROOT_DISPLAY_NAME = "My Files";

export const getDirectory = async (directoryId, userId) => {
	const directory = await Directory.findOne({
		_id: directoryId,
		userId,
	}).lean();

	if (!directory) {
		throw new AppError("Directory not found", NOT_FOUND, DIRECTORY_NOT_FOUND);
	}

	// Fetch the immediate files, child directories, and ancestor names in parallel
	const [files, childDirs, ancestors] = await Promise.all([
		File.find({ parentDirId: directory._id, userId, status: "ready" })
			.select("-status -uploadExpiresAt")
			.lean(),
		Directory.find({ parentDirId: directory._id, userId }).lean(),
		resolveDirectoryNames(directory.ancestorIds, userId),
	]);

	const breadcrumb = generateBreadCrumb(ancestors, directory);
	if (breadcrumb.length) breadcrumb[0].name = ROOT_DISPLAY_NAME;

	const path = generatePath(breadcrumb);
	const filesForResponse = files.map((file) => ({
		...file,
		id: file._id,
	}));

	// Expose the stored subtree size as `totalSize`; drop the raw `size` and the
	// internal `ancestorIds` from the response (top-level and each child).
	const childDirectories = childDirs.map(({ size, ancestorIds, ...dir }) => ({
		...dir,
		id: dir._id,
		totalSize: size,
	}));

	const { size, ancestorIds, ...directoryView } = directory;
	return {
		...directoryView,
		name: directory.parentDirId ? directory.name : ROOT_DISPLAY_NAME,
		totalSize: size,
		breadcrumb,
		path,
		files: filesForResponse,
		childDirectories,
	};
};

export const createDirectory = async (parentDirId, dirname, userId) => {
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

	let directory;
	const session = await mongoose.startSession();
	try {
		await session.withTransaction(async () => {
			const created = await Directory.create(
				[
					{
						name: dirname,
						parentDirId,
						userId,
						ancestorIds: [...parentDir.ancestorIds, parentDir._id],
					},
				],
				{ session },
			);

			// The new folder adds one folder to every ancestor's subtree. Its own
			// folderCount stays 0, so the walk starts at the parent, not at it.
			await updateAncestorDirectoryStats(parentDirId, { folders: 1 }, session);

			directory = created[0];
		});
	} finally {
		session.endSession();
	}

	// ancestorIds is internal denormalization — drop it so the create and read
	// (getDirectory) contracts stay symmetric.
	const { ancestorIds, ...directoryView } = directory.toObject();
	return directoryView;
};

export const updateDirectory = async (directoryId, newDirName, userId) => {
	const directory = await Directory.findOne({
		_id: directoryId,
		userId,
	}).lean();

	if (!directory) {
		throw new AppError("Directory not found", NOT_FOUND, DIRECTORY_NOT_FOUND);
	}

	// Prevent renaming of root directory
	if (!directory.parentDirId) {
		throw new AppError(
			"Cannot rename root directory",
			BAD_REQUEST,
			DIRECTORY_RENAME_FAILED,
		);
	}

	const updatedDirectory = await Directory.findOneAndUpdate(
		{ _id: directoryId, userId },
		{ name: newDirName },
		{ new: true, runValidators: true },
	).lean();

	return updatedDirectory;
};

export const deleteDirectory = async (directoryId, userId) => {
	// Step 1: Find the directory to delete
	const rootDir = await Directory.findOne({ _id: directoryId, userId }).lean();

	if (!rootDir) {
		throw new AppError("Directory not found", NOT_FOUND, DIRECTORY_NOT_FOUND);
	}

	// Prevent deletion of root directory
	if (!rootDir.parentDirId) {
		throw new AppError(
			"Cannot delete root directory",
			BAD_REQUEST,
			DIRECTORY_DELETE_FAILED,
		);
	}

	// Step 2: Every directory in the subtree. `ancestorIds` has no depth limit,
	// so the guard below sees everything the refund is about to subtract.
	const descendants = await Directory.find(
		{ userId, ancestorIds: rootDir._id },
		"_id",
	).lean();
	const allDirIds = [rootDir._id, ...descendants.map((dir) => dir._id)];

	// Step 3: Fetch all files within these directories belonging to the user
	const allFiles = await File.find({
		parentDirId: { $in: allDirIds },
		userId,
	})
		.select("+objectKey")
		.lean();

	// Step 4: Block only while a presigned URL could still write. A pending
	// upload past its deadline is dead weight and is deleted with the rest.
	const now = new Date();
	const hasLiveUpload = allFiles.some(
		(file) =>
			file.status !== "ready" &&
			(!file.uploadExpiresAt || file.uploadExpiresAt > now),
	);

	if (hasLiveUpload) {
		throw new AppError(
			"Directory has uploads in progress; try again shortly",
			CONFLICT,
			UPLOAD_IN_PROGRESS,
		);
	}

	// Step 5: Delete all files and directories from the DB atomically
	const session = await mongoose.startSession();

	try {
		await session.withTransaction(async () => {
			const hasLiveUploadNow = await File.exists({
				parentDirId: { $in: allDirIds },
				userId,
				status: { $ne: "ready" },
				$or: [
					{ uploadExpiresAt: { $exists: false } },
					{ uploadExpiresAt: { $gt: new Date() } },
				],
			}).session(session);

			if (hasLiveUploadNow) {
				throw new AppError(
					"Directory has uploads in progress; try again shortly",
					CONFLICT,
					UPLOAD_IN_PROGRESS,
				);
			}

			// Fetch the current totals for the root directory before deletion
			const currentTotals = await Directory.findById(
				rootDir._id,
				"size fileCount",
				{ session },
			).lean();

			await File.deleteMany(
				{ parentDirId: { $in: allDirIds }, userId },
				{ session },
			);

			await Directory.deleteMany(
				{ _id: { $in: allDirIds }, userId },
				{ session },
			);

			// Subtract the deleted subtree's totals from every ancestor above it.
			await updateAncestorDirectoryStats(
				rootDir.parentDirId,
				{
					bytes: -(currentTotals?.size ?? 0),
					files: -(currentTotals?.fileCount ?? 0),
					folders: -allDirIds.length,
				},
				session,
			);
		});
	} finally {
		session.endSession();
	}

	// Step 6: Delete the physical files from R2
	await removeObjects(
		allFiles.map((file) => ({
			key: file.objectKey,
			label: `file ${file._id}`,
		})),
	);

	return rootDir;
};

// Updates the counts on this folder and every folder above it.
// Pass in the caller's database session so this change succeeds or fails together with theirs.
export const updateAncestorDirectoryStats = async (
	startDirId,
	{ bytes = 0, files = 0, folders = 0 },
	session,
) => {
	const ancestorDirIds = [];
	let currentDirId = startDirId;

	while (currentDirId) {
		// Project to parentDirId only because we only need _id and parentDirId for the walk
		const currentDir = await Directory.findById(currentDirId, "parentDirId", {
			session,
		});
		if (!currentDir) break;
		ancestorDirIds.push(currentDir._id);
		currentDirId = currentDir.parentDirId;
	}

	if (ancestorDirIds.length === 0) return;

	await Directory.updateMany(
		{ _id: { $in: ancestorDirIds } },
		{ $inc: { size: bytes, fileCount: files, folderCount: folders } },
		{ session },
	);
};

// Turns a list of folder IDs into { _id, name } pairs, in the same order.
// Only the user's own folders get a name; any other ID comes back without one.
export const resolveDirectoryNames = async (dirIds, userId) => {
	if (!dirIds?.length) return [];

	const dirs = await Directory.find(
		{ _id: { $in: dirIds }, userId },
		"name",
	).lean();

	const nameById = new Map(dirs.map((dir) => [dir._id.toString(), dir.name]));

	return dirIds.map((id) => ({ _id: id, name: nameById.get(id.toString()) }));
};
