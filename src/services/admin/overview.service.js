//* src/services/admin/overview.service.js

import User from "../../models/user.model.js";
import File from "../../models/file.model.js";
import Directory from "../../models/directory.model.js";
import Session from "../../models/session.model.js";

import { ROLES } from "../../constants/roles.js";
import { SEVEN_DAYS_MS, THIRTY_DAYS_MS } from "../../utils/date.js";

/**
 * System-wide point-in-time aggregates for the admin dashboard.
 *
 * User counts are computed from `suspendedAt` / `deletedAt` timestamps so the
 * derived-status invariant holds — there is no stored `status` field.
 */
export const getSystemOverview = async () => {
	const now = new Date();
	const sevenDaysAgo = new Date(now.getTime() - SEVEN_DAYS_MS);
	const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);

	const [
		usersTotal,
		usersActive,
		usersSuspended,
		usersSoftDeleted,
		usersByUser,
		usersByAdmin,
		usersBySuperadmin,
		storageAgg,
		directoryCount,
		signupsLast7d,
		signupsLast30d,
		activeSessions,
	] = await Promise.all([
		User.countDocuments({}),
		User.countDocuments({ suspendedAt: null, deletedAt: null }),
		User.countDocuments({ suspendedAt: { $ne: null }, deletedAt: null }),
		User.countDocuments({ deletedAt: { $ne: null } }),

		// byRole is a population view — no lifecycle filter — so the invariant
		// `users.total === byRole.user + byRole.admin + byRole.superadmin` holds.
		User.countDocuments({ role: ROLES.USER }),
		User.countDocuments({ role: ROLES.ADMIN }),
		User.countDocuments({ role: ROLES.SUPERADMIN }),
		File.aggregate([
			{ $match: { status: "ready" } },
			{
				$group: {
					_id: null,
					totalFiles: { $sum: 1 },
					totalBytes: { $sum: "$size" },
				},
			},
		]),
		Directory.countDocuments({}),
		User.countDocuments({ createdAt: { $gt: sevenDaysAgo } }),
		User.countDocuments({ createdAt: { $gt: thirtyDaysAgo } }),
		Session.countDocuments({ expiresAt: { $gt: now } }),
	]);

	// Handle cases where there are no files or directories, or no storage data.
	const { totalFiles = 0, totalBytes = 0 } = storageAgg[0] ?? {};

	return {
		users: {
			total: usersTotal,
			active: usersActive,
			suspended: usersSuspended,
			softDeleted: usersSoftDeleted,
			byRole: {
				[ROLES.USER]: usersByUser,
				[ROLES.ADMIN]: usersByAdmin,
				[ROLES.SUPERADMIN]: usersBySuperadmin,
			},
		},
		storage: {
			totalBytes,
			totalFiles,
			totalDirectories: directoryCount,
		},
		signups: {
			last7d: signupsLast7d,
			last30d: signupsLast30d,
		},
		sessions: {
			active: activeSessions,
		},
	};
};
