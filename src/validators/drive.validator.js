//* src/validators/drive.validator.js

import { z } from "zod";

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;
const MAX_ACCESS_TOKEN_LENGTH = 4096;
const MAX_ITEMS_PER_REQUEST = 50;

// Only `id` is used; the file details are fetched again from Drive.
// `mimeType` is still required so the request format stays the same.
const driveItemSchema = z.object({
	id: z.string().trim().nonempty("each item requires a string id"),
	mimeType: z.string().trim().nonempty("each item requires a string mimeType"),
});

export const importDriveSchema = z.object({
	accessToken: z
		.string()
		.trim()
		.nonempty("accessToken is required")
		.max(MAX_ACCESS_TOKEN_LENGTH, "accessToken is malformed"),
	items: z
		.array(driveItemSchema)
		.min(1, "items must be a non-empty array")
		.max(
			MAX_ITEMS_PER_REQUEST,
			`items must contain at most ${MAX_ITEMS_PER_REQUEST} entries`,
		),
	parentDirId: z
		.string("parentDirId must be a string when provided")
		.trim()
		.regex(OBJECT_ID_PATTERN, "Invalid directory id")
		.optional(),
});
