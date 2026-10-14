//* src/controllers/admin/user.controller.js

import httpStatus from "../../constants/httpStatus.js";
import {
	listUsers,
	getUserById,
	changeUserRole,
	suspendUser,
	unsuspendUser,
	forceLogoutUser,
	softDeleteUser,
	hardDeleteUser,
	restoreUser,
} from "../../services/admin/user.service.js";
import { formatUser } from "../../services/user.service.js";

const { OK } = httpStatus;

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Turns a query value (always a string, or missing) into a whole number in range.
// Bad or too-small values give the fallback; too-large values are capped at max.
const clampInt = (raw, fallback, { min, max }) => {
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < min) return fallback;
	if (max !== undefined && parsed > max) return max;
	return parsed;
};

export const listUsersHandler = async (req, res) => {
	const {
		page: pageRaw,
		limit: limitRaw,
		q,
		role,
		status,
		includeDeleted,
	} = req.query;

	const page = clampInt(pageRaw, DEFAULT_PAGE, { min: 1 });
	const limit = clampInt(limitRaw, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });

	const result = await listUsers({
		page,
		limit,
		q: typeof q === "string" ? q.trim() : undefined,
		role: typeof role === "string" ? role : undefined,
		status: typeof status === "string" ? status : undefined,
		includeDeleted: includeDeleted === "true",
	});

	res.status(OK).json({
		success: true,
		message: "Users fetched successfully",
		data: {
			...result,
			items: await Promise.all(result.items.map(formatUser)),
		},
	});
};

export const getUserByIdHandler = async (req, res) => {
	const { id } = req.params;

	const user = await getUserById(id);

	res.status(OK).json({
		success: true,
		message: "User fetched successfully",
		data: await formatUser(user),
	});
};

export const changeUserRoleHandler = async (req, res) => {
	const { id } = req.params;
	const { role } = req.body ?? {};
	const user = req.user;

	const updatedUser = await changeUserRole(user, id, role);

	res.status(OK).json({
		success: true,
		message: "User role updated successfully",
		data: await formatUser(updatedUser),
	});
};

export const suspendUserHandler = async (req, res) => {
	const { id } = req.params;
	const user = req.user;

	const suspendedUser = await suspendUser(user, id);

	res.status(OK).json({
		success: true,
		message: "User suspended successfully",
		data: await formatUser(suspendedUser),
	});
};

export const unsuspendUserHandler = async (req, res) => {
	const { id } = req.params;
	const user = req.user;

	const unsuspendedUser = await unsuspendUser(user, id);

	res.status(OK).json({
		success: true,
		message: "User unsuspended successfully",
		data: await formatUser(unsuspendedUser),
	});
};

export const forceLogoutUserHandler = async (req, res) => {
	const { id } = req.params;
	const user = req.user;

	const loggedOutResult = await forceLogoutUser(user, id);

	res.status(OK).json({
		success: true,
		message: "User sessions revoked successfully",
		data: loggedOutResult,
	});
};

export const softDeleteUserHandler = async (req, res) => {
	const { id } = req.params;
	const user = req.user;

	const deletedUser = await softDeleteUser(user, id);

	res.status(OK).json({
		success: true,
		message: "User soft-deleted successfully",
		data: await formatUser(deletedUser),
	});
};

export const hardDeleteUserHandler = async (req, res) => {
	const { id } = req.params;
	const user = req.user;

	const purgedResult = await hardDeleteUser(user, id);

	res.status(OK).json({
		success: true,
		message: "User permanently deleted",
		data: purgedResult,
	});
};

export const restoreUserHandler = async (req, res) => {
	const { id } = req.params;
	const user = req.user;

	const restoredUser = await restoreUser(user, id);

	res.status(OK).json({
		success: true,
		message: "User restored successfully",
		data: await formatUser(restoredUser),
	});
};
