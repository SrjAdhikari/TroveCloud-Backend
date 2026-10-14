//* src/constants/roles.js

export const ROLES = Object.freeze({
	USER: "user",
	ADMIN: "admin",
	SUPERADMIN: "superadmin",
});

// A higher number means more access: a higher role passes checks meant for lower roles.
export const ROLE_RANK = Object.freeze({
	[ROLES.USER]: 1,
	[ROLES.ADMIN]: 2,
	[ROLES.SUPERADMIN]: 3,
});
