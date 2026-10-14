//* src/middlewares/validate.middleware.js

import { isValidObjectId } from "mongoose";

import AppError from "../errors/AppError.js";

import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";

const { BAD_REQUEST } = httpStatus;
const { VALIDATION_ERROR, INVALID_ID } = appErrorCode;

// Replaces the request body with the cleaned-up version, so trimmed and lowercased values reach the controller.
// Invalid input is turned into a 400 response.
export const validateBody = (schema) => (req, res, next) => {
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

export const validateId = (req, res, next, id) => {
	if (!isValidObjectId(id)) {
		throw new AppError("Invalid ID format", BAD_REQUEST, INVALID_ID);
	}

	next();
};
