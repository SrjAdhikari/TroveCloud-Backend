//* src/middlewares/auth.middleware.js

import Session from "../models/session.model.js";
import AppError from "../errors/AppError.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import { clearAuthCookie } from "../utils/cookies.js";

const { UNAUTHORIZED, FORBIDDEN } = httpStatus;
const { UNAUTHORIZED_ACCESS, ACCOUNT_SUSPENDED } = appErrorCode;

const authenticate = async (req, res, next) => {
	const sessionId = req.signedCookies.token;

	if (!sessionId) {
		throw new AppError(
			"Unauthorized access",
			UNAUTHORIZED,
			UNAUTHORIZED_ACCESS,
		);
	}

	// Fetch session and populate the associated user in one round-trip
	const session = await Session.findById(sessionId)
		.populate("userId", "-password -otp -otpExpiresAt")
		.lean();

	// Session expired via TTL or user was deleted
	if (!session || !session.userId) {
		clearAuthCookie(res);
		throw new AppError(
			"Invalid or expired session",
			UNAUTHORIZED,
			UNAUTHORIZED_ACCESS,
		);
	}

	// Soft-deleted user — surface as a generic unauthorized so account existence is not leaked.
	// Order matters: deletion takes precedence over suspension.
	if (session.userId.deletedAt) {
		clearAuthCookie(res);
		throw new AppError(
			"Account no longer exists",
			UNAUTHORIZED,
			UNAUTHORIZED_ACCESS,
		);
	}

	// Suspended user — explicit, distinct error so the client can render a tailored message.
	if (session.userId.suspendedAt) {
		clearAuthCookie(res);
		throw new AppError(
			"Account is suspended",
			FORBIDDEN,
			ACCOUNT_SUSPENDED,
		);
	}

	// Attach the populated User document and Session ID to the request object
	req.user = session.userId;
	req.sessionId = session._id;

	next();
};

export default authenticate;
