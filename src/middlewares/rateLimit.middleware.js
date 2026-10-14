//* src/middlewares/rateLimit.middleware.js

import { rateLimit, ipKeyGenerator } from "express-rate-limit";

import AppError from "../errors/AppError.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import { FIFTEEN_MINUTES_MS } from "../utils/date.js";

const { TOO_MANY_REQUESTS } = httpStatus;
const { RATE_LIMITED } = appErrorCode;

// Counts requests per real user (or real visitor IP), not the Cloudflare IP Express sees.
// Otherwise many users would share the same limit.
export const clientKey = (req) => {
	if (req.user?._id) return req.user._id.toString();
	const ip = req.headers["cf-connecting-ip"] ?? req.ip;
	return ipKeyGenerator(ip, 56);
};

// Sends the rate-limit error in the normal app error format instead of plain text.
export const rateLimitExceededHandler = (req, res, next) =>
	next(
		new AppError(
			"Too many requests, please try again later",
			TOO_MANY_REQUESTS,
			RATE_LIMITED,
		),
	);

// Starting time windows and request limits for each group of routes.
const RATE_LIMITS = {
	global: { windowMs: FIFTEEN_MINUTES_MS, limit: 1000 },
	auth: { windowMs: FIFTEEN_MINUTES_MS, limit: 10 },
	oauth: { windowMs: FIFTEEN_MINUTES_MS, limit: 20 },
	read: { windowMs: FIFTEEN_MINUTES_MS, limit: 100 },
	mutation: { windowMs: FIFTEEN_MINUTES_MS, limit: 40 },
	destructive: { windowMs: FIFTEEN_MINUTES_MS, limit: 15 },
	hardDelete: { windowMs: FIFTEEN_MINUTES_MS, limit: 5 },
	upload: { windowMs: FIFTEEN_MINUTES_MS, limit: 50 },
	drive: { windowMs: FIFTEEN_MINUTES_MS, limit: 5 },
};

const createLimiter = ({ windowMs, limit }) =>
	rateLimit({
		windowMs,
		limit,
		standardHeaders: true,
		legacyHeaders: false,
		keyGenerator: clientKey,
		handler: rateLimitExceededHandler,
	});

export const globalLimiter = createLimiter(RATE_LIMITS.global);
export const authLimiter = createLimiter(RATE_LIMITS.auth);
export const oauthLimiter = createLimiter(RATE_LIMITS.oauth);
export const readLimiter = createLimiter(RATE_LIMITS.read);
export const mutationLimiter = createLimiter(RATE_LIMITS.mutation);
export const destructiveLimiter = createLimiter(RATE_LIMITS.destructive);
export const hardDeleteLimiter = createLimiter(RATE_LIMITS.hardDelete);
export const uploadLimiter = createLimiter(RATE_LIMITS.upload);
export const driveLimiter = createLimiter(RATE_LIMITS.drive);
