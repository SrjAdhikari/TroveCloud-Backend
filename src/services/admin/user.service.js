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
import { deleteObject } from "../../lib/r2.js";

const { BAD_REQUEST, NOT_FOUND, FORBIDDEN } = httpStatus;
const {
	INVALID_INPUT,
	USER_NOT_FOUND,
	CANNOT_ACT_ON_SELF,
	CANNOT_ACT_ON_PEER,
} = appErrorCode;

// Convert the constant objects into plain arrays.
const ALLOWED_ROLES = Object.values(ROLES);
const ALLOWED_STATUSES = Object.values(USER_STATUS);

// Escape regex metacharacters so user-supplied search terms cannot inject regex syntax.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the Mongo filter that implements the admin user-list semantics from RBAC.
 * Status maps to timestamp predicates; `includeDeleted` only matters when no
 * explicit `status` filter is supplied.
 */
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

/**
 * Converts user to plain object and adds computed status
 *
 * @param {MongooseDocument} user - Mongoose document
 * @returns {object} - Plain user object with status
 */
const toPlainUser = (user) => ({
	...user.toObject(),
	status: getUserStatus(user),
});

/**
 * Prevents the caller from performing destructive operations on their own account
 *
 * @param {string} callerId - ID of the caller
 * @param {string} targetId - ID of the target
 */
const assertNotSelf = (callerId, targetId) => {
	if (String(callerId) === String(targetId)) {
		throw new AppError(
			"Cannot perform this action on your own account",
			FORBIDDEN,
			CANNOT_ACT_ON_SELF,
		);
	}
};

/**
 * Prevents the caller from performing operations on a user of equal or higher rank
 *
 * @param {object} caller - User doing the action (has .role)
 * @param {object} target - User being acted on (has .role)
 */
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

/**
 * Finds the target user by ID or throws 404
 * @param {string} id - ID of the user to find
 */
const findUserById = async (id) => {
	const user = await User.findById(id);
	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	return user;
};

/**
 * Paginated user list for the admin console.
 *
 * @param {object} options
 * @param {number} options.page - Current page number.
 * @param {number} options.limit - Number of users per page.
 * @param {string} [options.q] - Case-insensitive email/name search.
 * @param {string} [options.role] - Restrict by role.
 * @param {string} [options.status] - One of `active | suspended | deleted`.
 * @param {boolean} [options.includeDeleted] - Include soft-deleted users when no status filter is set.
 */
const listUsers = async ({ page, limit, q, role, status, includeDeleted }) => {
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

/**
 * Detailed admin view of a single user, including derived storage, file,
 * directory, and session metrics. Soft-deleted users are returned so admins
 * can inspect them; the consumer can branch on the `status` field.
 *
 * @param {string} id - User _id (ObjectId string).
 */
const getUserById = async (id) => {
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

/**
 * Updates the target user's role
 *
 * @param {object} caller - The admin making the request (has _id and role)
 * @param {string} targetId - ID of the user to update
 * @param {"user"|"admin"|"superadmin"} newRole - New role to assign to the user
 *
 * @returns {Promise<object>} - Object containing the updated user
 */
const changeUserRole = async (caller, targetId, newRole) => {
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

/**
 * Suspends the target user
 *
 * @param {object} caller - User object
 * @param {string} targetId - ID of the user to suspend
 */
const suspendUser = async (caller, targetId) => {
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

/**
 * Lifts a suspension for the target user
 * Sessions are NOT automatically restored — the user must log in again
 *
 * @param {object} caller - User object
 * @param {string} targetId - ID of the user to unsuspend
 *
 * @returns {Promise<object>} - Object containing the unsuspended user
 */
const unsuspendUser = async (caller, targetId) => {
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

/**
 * Force-revokes every active session for the target
 *
 * @param {object} caller - User object
 * @param {string} targetId - ID of the user to force-logout
 *
 * @returns {Promise<object>} - Object containing the number of sessions revoked
 */
const forceLogoutUser = async (caller, targetId) => {
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

/**
 * Soft delete user
 * Files/directories survive until hard-delete or restore
 *
 * @param {object} caller - User object
 * @param {string} targetId - ID of the user to soft-delete
 *
 * @returns {Promise<object>} - Object containing the soft-deleted user
 */
const softDeleteUser = async (caller, targetId) => {
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

/**
 * Hard delete user
 * Irreversibly wipes the user and all their data from MongoDB
 * then deletes their objects from R2
 *
 * @param {object} caller - User object
 * @param {string} targetId - ID of the user to hard-delete
 *
 * @returns {Promise<object>} - Object containing the number of files and directories deleted
 */
const hardDeleteUser = async (caller, targetId) => {
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
	await Promise.allSettled(
		objectsToWipe.map(async ({ key, label }) => {
			try {
				await deleteObject(key);
			} catch (error) {
				console.warn(
					`Hard-delete: failed to remove the object for ${label}: ${error.name} ${error.$metadata?.httpStatusCode ?? ""}`.trim(),
				);
			}
		}),
	);

	return deletionSummary;
};

/**
 * Restore soft-deleted user
 *
 * @param {object} caller - User object
 * @param {string} targetId - ID of the user to restore
 *
 * @returns {Promise<object>} - Object containing the restored user
 */
const restoreUser = async (caller, targetId) => {
	const user = await findUserById(targetId);

	if (!user.deletedAt) {
		throw new AppError("User is not deleted", BAD_REQUEST, INVALID_INPUT);
	}

	assertCanActOn(caller, user);

	user.deletedAt = null;
	await user.save();

	return toPlainUser(user);
};

export {
	listUsers,
	getUserById,
	changeUserRole,
	suspendUser,
	unsuspendUser,
	forceLogoutUser,
	softDeleteUser,
	hardDeleteUser,
	restoreUser,
};
