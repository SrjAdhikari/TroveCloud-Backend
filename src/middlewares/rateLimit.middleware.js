//* src/middlewares/rateLimit.middleware.js

import { rateLimit, ipKeyGenerator } from "express-rate-limit";

import AppError from "../errors/AppError.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import { FIFTEEN_MINUTES_MS } from "../utils/date.js";

const { TOO_MANY_REQUESTS } = httpStatus;
const { RATE_LIMITED } = appErrorCode;

/**
 * Resolves the key each limiter counts against — the REAL end user, not the
 * Cloudflare edge IP that Express sees as `req.ip` once requests pass through
 * the proxy. Getting this wrong collapses every user into a handful of buckets.
 *
 * @param {import("express").Request} req
 * @returns {string} the identifier the limiter buckets on
 */
const clientKey = (req) => {
	if (req.user?._id) return req.user._id.toString();
	const ip = req.headers["cf-connecting-ip"] ?? req.ip;
	return ipKeyGenerator(ip, 56);
};

/**
 * Converts express-rate-limit's 429 into the project error envelope by routing
 * an AppError through the global error handler — instead of the library's
 * default plaintext "Too many requests" body, which breaks the response contract.
 */
const rateLimitExceededHandler = (req, res, next) =>
	next(
		new AppError(
			"Too many requests, please try again later",
			TOO_MANY_REQUESTS,
			RATE_LIMITED,
		),
	);

/**
 * Starter windows + per-key request caps per tier.
 */
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

const globalLimiter = createLimiter(RATE_LIMITS.global);
const authLimiter = createLimiter(RATE_LIMITS.auth);
const oauthLimiter = createLimiter(RATE_LIMITS.oauth);
const readLimiter = createLimiter(RATE_LIMITS.read);
const mutationLimiter = createLimiter(RATE_LIMITS.mutation);
const destructiveLimiter = createLimiter(RATE_LIMITS.destructive);
const hardDeleteLimiter = createLimiter(RATE_LIMITS.hardDelete);
const uploadLimiter = createLimiter(RATE_LIMITS.upload);
const driveLimiter = createLimiter(RATE_LIMITS.drive);

export {
	clientKey,
	rateLimitExceededHandler,
	globalLimiter,
	authLimiter,
	oauthLimiter,
	readLimiter,
	mutationLimiter,
	destructiveLimiter,
	hardDeleteLimiter,
	uploadLimiter,
	driveLimiter,
};
