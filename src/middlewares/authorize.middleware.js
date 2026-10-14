//* src/middlewares/authorize.middleware.js

import AppError from "../errors/AppError.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import { ROLES, ROLE_RANK } from "../constants/roles.js";

const { UNAUTHORIZED, FORBIDDEN } = httpStatus;
const { UNAUTHORIZED_ACCESS, INSUFFICIENT_ROLE } = appErrorCode;

/**
 * Role-aware authorization middleware.
 *
 * Compares `req.user.role` against `minRole` using `ROLE_RANK`.
 * A caller of equal or higher rank passes; lower rank, missing role, or
 * unrecognised role produces 403 INSUFFICIENT_ROLE (fails closed).
 *
 * `minRole` is validated at registration time so a typo throws at server
 * boot rather than silently allowing every caller through.
 *
 * @param {"user" | "admin" | "superadmin"} minRole
 */
export const requireRole = (minRole) => {
	const requiredRank = ROLE_RANK[minRole];

	if (typeof requiredRank !== "number") {
		throw new Error(
			`requireRole: unknown role "${minRole}". Expected one of ${Object.values(ROLES).join(", ")}.`,
		);
	}

	return (req, res, next) => {
		if (!req.user) {
			throw new AppError("Unauthorized", UNAUTHORIZED, UNAUTHORIZED_ACCESS);
		}

		const callerRank = ROLE_RANK[req.user.role];

		if (typeof callerRank !== "number" || callerRank < requiredRank) {
			throw new AppError("Insufficient role", FORBIDDEN, INSUFFICIENT_ROLE);
		}

		next();
	};
};

/**
 * Shorthand for `requireRole('superadmin')`.
 */
export const requireSuperadmin = () => requireRole(ROLES.SUPERADMIN);
