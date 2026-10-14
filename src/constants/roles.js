//* src/constants/roles.js

/**
 * Application role identifiers.
 *
 * @readonly
 * @enum {string}
 */
export const ROLES = Object.freeze({
	USER: "user",
	ADMIN: "admin",
	SUPERADMIN: "superadmin",
});

/**
 * Numeric rank used for hierarchical role comparisons.
 * Higher rank passes lower role checks.
 *
 * @readonly
 */
export const ROLE_RANK = Object.freeze({
	[ROLES.USER]: 1,
	[ROLES.ADMIN]: 2,
	[ROLES.SUPERADMIN]: 3,
});
