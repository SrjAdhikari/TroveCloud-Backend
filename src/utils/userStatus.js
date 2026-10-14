//* src/utils/userStatus.js

/**
 * Lifecycle status of a user, derived from `suspendedAt` / `deletedAt` timestamps.
 * Status is never stored on the User schema — it is computed on the fly so that
 * the timestamps remain the single source of truth.
 *
 * @readonly
 * @enum {string}
 */
export const USER_STATUS = Object.freeze({
	ACTIVE: "active",
	SUSPENDED: "suspended",
	DELETED: "deleted",
});

/**
 * Derives a user's lifecycle status from its timestamps.
 *
 * `deletedAt` takes precedence over `suspendedAt` so a soft-deleted user is
 * never reported as merely suspended even if both timestamps are set.
 *
 * @param {{ deletedAt?: Date | null, suspendedAt?: Date | null }} user
 * @returns {"active" | "suspended" | "deleted"}
 */
export const getUserStatus = (user) => {
	if (user.deletedAt) return USER_STATUS.DELETED;
	if (user.suspendedAt) return USER_STATUS.SUSPENDED;
	return USER_STATUS.ACTIVE;
};
