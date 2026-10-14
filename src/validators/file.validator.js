//* src/validators/file.validator.js

import path from "node:path";
import { z } from "zod";

import sanitizeInput from "../utils/sanitizeInput.js";
import envConfig from "../constants/env.js";

const { MAX_FILE_UPLOAD_SIZE } = envConfig;

const MAX_NAME_LENGTH = 255;
const MIN_NAME_LENGTH = 3;

// Strip any HTML, then reduce to a base name (defuses traversal),
// strip control characters and backslashes, trim and bound length.
export const sanitizeFileName = (value) =>
	path
		.basename(sanitizeInput(value))
		.replace(/[\r\n\t\\]/g, "")
		.trim()
		.slice(0, MAX_NAME_LENGTH);

export const renameFileSchema = z.object({
	newFileName: z
		.string("Valid file name is required")
		.transform(sanitizeFileName)
		.refine((value) => value.length > 0, "Valid file name is required"),
});

export const initiateUploadSchema = z.object({
	name: z
		.string("Valid file name is required")
		.transform(sanitizeFileName)
		.refine(
			(value) => value.length >= MIN_NAME_LENGTH,
			"Valid file name is required",
		),
	size: z
		.number("Valid file size is required")
		.int("File size must be a whole number of bytes")
		.positive("File size must be greater than zero")
		.max(MAX_FILE_UPLOAD_SIZE, "File exceeds upload size cap"),
});
