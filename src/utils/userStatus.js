//* src/utils/userStatus.js

// A user's status is never saved. It is worked out from the suspendedAt and deletedAt dates,
// so those dates stay the single source of truth.
export const USER_STATUS = Object.freeze({
	ACTIVE: "active",
	SUSPENDED: "suspended",
	DELETED: "deleted",
});

// Deleted wins over suspended, so a deleted user is never shown as only suspended.
export const getUserStatus = (user) => {
	if (user.deletedAt) return USER_STATUS.DELETED;
	if (user.suspendedAt) return USER_STATUS.SUSPENDED;
	return USER_STATUS.ACTIVE;
};
