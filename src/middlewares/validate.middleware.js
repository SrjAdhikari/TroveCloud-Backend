//* src/middlewares/validate.middleware.js

import { isValidObjectId } from "mongoose";

import AppError from "../errors/AppError.js";

import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";

const { BAD_REQUEST } = httpStatus;
const { VALIDATION_ERROR, INVALID_ID } = appErrorCode;

/**
 * Builds a middleware that validates `req.body` against a Zod schema.
 *
 * On success the parsed (and normalized) data replaces `req.body` so trimming,
 * lowercasing, and type coercion flow downstream. On failure it throws an
 * AppError that the global error handler converts to a 400 response.
 *
 * @param {import("zod").ZodType} schema - Zod schema to validate the body with.
 * @returns {import("express").RequestHandler}
 */
const validateBody = (schema) => (req, res, next) => {
	const result = schema.safeParse(req.body ?? {});

	if (!result.success) {
		const message = result.error.issues
			.map((issue) => issue.message)
			.join("; ");

		throw new AppError(message, BAD_REQUEST, VALIDATION_ERROR);
	}

	req.body = result.data;
	next();
};

/**
 * Validates if a given router parameter is a valid MongoDB ObjectId.
 *
 * @param {import("express").Request} req - Express request object.
 * @param {import("express").Response} res - Express response object.
 * @param {import("express").NextFunction} next - Express next middleware function.
 * @param {string} id - The ID to validate.
 * @throws {AppError} - If the value is not a valid ObjectId.
 */
const validateId = (req, res, next, id) => {
	if (!isValidObjectId(id)) {
		throw new AppError("Invalid ID format", BAD_REQUEST, INVALID_ID);
	}

	next();
};

export { validateBody, validateId };
