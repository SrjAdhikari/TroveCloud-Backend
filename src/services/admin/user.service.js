//* src/services/admin/user.service.js

import mongoose from "mongoose";

import User from "../../models/user.model.js";
import File from "../../models/file.model.js";
import Directory from "../../models/directory.model.js";
import Session from "../../models/session.model.js";

import AppError from "../../errors/AppError.js";
import httpStatus from "../../constants/httpStatus.js";
import appErrorCode from "../../constants/appErrorCode.js";
import { ROLES, ROLE_RANK } from "../../constants/roles.js";
import { USER_STATUS, getUserStatus } from "../../utils/userStatus.js";
import { removeObjects } from "../file/objectCleanup.service.js";

const { BAD_REQUEST, NOT_FOUND, FORBIDDEN } = httpStatus;
const {
	INVALID_INPUT,
	USER_NOT_FOUND,
	CANNOT_ACT_ON_SELF,
	CANNOT_ACT_ON_PEER,
} = appErrorCode;

const ALLOWED_ROLES = Object.values(ROLES);
const ALLOWED_STATUSES = Object.values(USER_STATUS);

// Treats special characters in the search text as plain text, so a search can't break the query.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The "include deleted" option is ignored when a status filter is set.
const buildListFilter = ({ q, role, status, includeDeleted }) => {
	const filter = {};

	if (q) {
		const regex = new RegExp(escapeRegex(q), "i");
		filter.$or = [{ email: regex }, { name: regex }];
	}

	if (role) filter.role = role;

	if (status === USER_STATUS.ACTIVE) {
		filter.suspendedAt = null;
		filter.deletedAt = null;
	} else if (status === USER_STATUS.SUSPENDED) {
		filter.suspendedAt = { $ne: null };
		filter.deletedAt = null;
	} else if (status === USER_STATUS.DELETED) {
		filter.deletedAt = { $ne: null };
	} else if (!includeDeleted) {
		filter.deletedAt = null;
	}

	return filter;
};

const toPlainUser = (user) => ({
	...user.toObject(),
	status: getUserStatus(user),
});

const assertNotSelf = (callerId, targetId) => {
	if (String(callerId) === String(targetId)) {
		throw new AppError(
			"Cannot perform this action on your own account",
			FORBIDDEN,
			CANNOT_ACT_ON_SELF,
		);
	}
};

// Admins can't act on users with the same or a higher role.
const assertCanActOn = (caller, target) => {
	const callerRank = ROLE_RANK[caller.role];
	const targetRank = ROLE_RANK[target.role];

	// Fail closed: unknown roles are rejected.
	if (
		typeof callerRank !== "number" ||
		typeof targetRank !== "number" ||
		callerRank <= targetRank
	) {
		throw new AppError(
			"Cannot act on a peer or higher",
			FORBIDDEN,
			CANNOT_ACT_ON_PEER,
		);
	}
};

const findUserById = async (id) => {
	const user = await User.findById(id);
	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	return user;
};

export const listUsers = async ({ page, limit, q, role, status, includeDeleted }) => {
	if (role && !ALLOWED_ROLES.includes(role)) {
		throw new AppError(
			`Invalid role filter. Allowed: ${ALLOWED_ROLES.join(", ")}`,
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	if (status && !ALLOWED_STATUSES.includes(status)) {
		throw new AppError(
			`Invalid status filter. Allowed: ${ALLOWED_STATUSES.join(", ")}`,
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	const filter = buildListFilter({ q, role, status, includeDeleted });

	const [items, total] = await Promise.all([
		User.find(filter)
			.sort({ createdAt: -1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.lean(),
		User.countDocuments(filter),
	]);

	const itemsWithStatus = items.map((user) => ({
		...user,
		status: getUserStatus(user),
	}));

	return {
		items: itemsWithStatus,
		pagination: {
			page,
			limit,
			total,
			totalPages: Math.max(1, Math.ceil(total / limit)),
		},
	};
};

// Deleted users are returned too, so admins can still look at them.
export const getUserById = async (id) => {
	const user = await User.findById(id).lean();
	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	const userObjectId = new mongoose.Types.ObjectId(id);
	const now = new Date();

	const [storageAgg, directoryCount, activeSessionCount, lastSession] =
		await Promise.all([
			File.aggregate([
				{ $match: { userId: userObjectId, status: "ready" } },
				{
					$group: {
						_id: null,
						fileCount: { $sum: 1 },
						storageBytes: { $sum: "$size" },
					},
				},
			]),
			Directory.countDocuments({ userId: userObjectId }),
			Session.countDocuments({
				userId: userObjectId,
				expiresAt: { $gt: now },
			}),
			Session.findOne({ userId: userObjectId })
				.sort({ createdAt: -1 })
				.select("createdAt")
				.lean(),
		]);

	// Handle cases where there are no files or directories, or no storage data.
	const { fileCount = 0, storageBytes = 0 } = storageAgg[0] ?? {};

	return {
		...user,
		status: getUserStatus(user),
		stats: {
			storageBytes,
			fileCount,
			directoryCount,
			activeSessionCount,
			lastLoginAt: lastSession?.createdAt ?? null,
		},
	};
};

export const changeUserRole = async (caller, targetId, newRole) => {
	if (!ALLOWED_ROLES.includes(newRole)) {
		throw new AppError(
			`Invalid role. Allowed: ${ALLOWED_ROLES.join(", ")}`,
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	assertNotSelf(caller._id, targetId);

	const user = await findUserById(targetId);
	if (user.deletedAt) {
		throw new AppError(
			"Cannot change role of a deleted user",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	assertCanActOn(caller, user);

	if (user.role !== newRole) {
		user.role = newRole;
		await user.save();
	}

	return toPlainUser(user);
};

export const suspendUser = async (caller, targetId) => {
	assertNotSelf(caller._id, targetId);

	const user = await findUserById(targetId);
	if (user.deletedAt) {
		throw new AppError(
			"Cannot suspend a deleted user",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	if (user.suspendedAt) {
		throw new AppError("User is already suspended", BAD_REQUEST, INVALID_INPUT);
	}

	assertCanActOn(caller, user);

	const mongooseSession = await mongoose.startSession();
	try {
		await mongooseSession.withTransaction(async () => {
			user.suspendedAt = new Date();
			user.suspendedBy = caller._id;
			await user.save({ session: mongooseSession });
			await Session.deleteMany(
				{ userId: user._id },
				{ session: mongooseSession },
			);
		});
	} finally {
		await mongooseSession.endSession();
	}

	return toPlainUser(user);
};

// Old sessions are not brought back; the user has to log in again.
export const unsuspendUser = async (caller, targetId) => {
	const user = await findUserById(targetId);
	if (user.deletedAt) {
		throw new AppError(
			"Cannot unsuspend a deleted user",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	if (!user.suspendedAt) {
		throw new AppError("User is not suspended", BAD_REQUEST, INVALID_INPUT);
	}

	assertCanActOn(caller, user);

	user.suspendedAt = null;
	user.suspendedBy = null;
	await user.save();

	return toPlainUser(user);
};

export const forceLogoutUser = async (caller, targetId) => {
	const user = await findUserById(targetId);

	// Self force-logout is harmless — admins can punt their own sessions.
	// For non-self targets, enforce the strict hierarchy.
	if (String(caller._id) !== String(targetId)) {
		assertCanActOn(caller, user);
	}

	if (user.deletedAt) {
		throw new AppError(
			"Cannot force-logout a deleted user",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	const { deletedCount } = await Session.deleteMany({ userId: user._id });

	return { sessionsRevoked: deletedCount };
};

// The user's files and folders are kept until the user is permanently deleted or restored.
export const softDeleteUser = async (caller, targetId) => {
	assertNotSelf(caller._id, targetId);

	const user = await findUserById(targetId);
	if (user.deletedAt) {
		throw new AppError("User is already deleted", BAD_REQUEST, INVALID_INPUT);
	}

	assertCanActOn(caller, user);

	const mongooseSession = await mongoose.startSession();
	try {
		await mongooseSession.withTransaction(async () => {
			user.deletedAt = new Date();
			await user.save({ session: mongooseSession });
			await Session.deleteMany(
				{ userId: user._id },
				{ session: mongooseSession },
			);
		});
	} finally {
		await mongooseSession.endSession();
	}

	return toPlainUser(user);
};

// Cannot be undone. Removes the user's records first, then their stored files.
export const hardDeleteUser = async (caller, targetId) => {
	assertNotSelf(caller._id, targetId);

	const user = await findUserById(targetId);

	assertCanActOn(caller, user);

	const userObjectId = user._id;
	const mongooseSession = await mongoose.startSession();

	let deletionSummary;
	let filesToWipe = [];
	let profilePictureKeyToWipe = null;

	try {
		await mongooseSession.withTransaction(async () => {
			const fileAgg = await File.aggregate([
				{ $match: { userId: userObjectId } },
				{
					$group: {
						_id: null,
						count: { $sum: 1 },
						bytes: { $sum: "$size" },
					},
				},
			]).session(mongooseSession);

			const files = await File.find({ userId: userObjectId }, "_id objectKey", {
				session: mongooseSession,
			}).lean();

			const owner = await User.findById(userObjectId, "profilePictureKey", {
				session: mongooseSession,
			}).lean();

			await Session.deleteMany(
				{ userId: userObjectId },
				{ session: mongooseSession },
			);

			await File.deleteMany(
				{ userId: userObjectId },
				{ session: mongooseSession },
			);

			const { deletedCount } = await Directory.deleteMany(
				{ userId: userObjectId },
				{ session: mongooseSession },
			);

			await User.deleteOne({ _id: userObjectId }, { session: mongooseSession });

			deletionSummary = {
				filesDeleted: fileAgg[0]?.count ?? 0,
				directoriesDeleted: deletedCount,
				bytesFreed: fileAgg[0]?.bytes ?? 0,
			};

			filesToWipe = files;
			profilePictureKeyToWipe = owner?.profilePictureKey ?? null;
		});
	} finally {
		await mongooseSession.endSession();
	}

	const objectsToWipe = filesToWipe.map((file) => ({
		key: file.objectKey,
		label: `file ${file._id}`,
	}));

	// If the user had a profile picture, add it to the list of objects to wipe.
	if (profilePictureKeyToWipe) {
		objectsToWipe.push({
			key: profilePictureKeyToWipe,
			label: `profile picture for user ${userObjectId}`,
		});
	}

	// Delete the stored objects from R2
	await removeObjects(objectsToWipe);

	return deletionSummary;
};

export const restoreUser = async (caller, targetId) => {
	const user = await findUserById(targetId);

	if (!user.deletedAt) {
		throw new AppError("User is not deleted", BAD_REQUEST, INVALID_INPUT);
	}

	assertCanActOn(caller, user);

	user.deletedAt = null;
	await user.save();

	return toPlainUser(user);
};
