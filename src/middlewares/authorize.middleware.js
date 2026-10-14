//* src/middlewares/authorize.middleware.js

import AppError from "../errors/AppError.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import { ROLES, ROLE_RANK } from "../constants/roles.js";

const { UNAUTHORIZED, FORBIDDEN } = httpStatus;
const { UNAUTHORIZED_ACCESS, INSUFFICIENT_ROLE } = appErrorCode;

// Lets in users whose role is at least the minimum; others, or an unknown role, get 403.
// A wrong minimum role throws when the server starts, so a typo can't let everyone in.
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

export const requireSuperadmin = () => requireRole(ROLES.SUPERADMIN);
