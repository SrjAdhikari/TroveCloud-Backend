//* src/validators/directory.validator.js

import { z } from "zod";
import sanitizeInput from "../utils/sanitizeInput.js";

const MAX_NAME_LENGTH = 255;
const DEFAULT_DIR_NAME = "New Folder";

// Removes HTML, line breaks, tabs and slashes, then trims and cuts to the max length.
const sanitizeDirName = (value) =>
	sanitizeInput(value)
		.replace(/[\r\n\t\\/]/g, "")
		.trim()
		.slice(0, MAX_NAME_LENGTH);

// The name is optional: a missing, invalid or empty name becomes "New Folder".
export const createDirectorySchema = z.object({
	name: z
		.string()
		.transform((value) => sanitizeDirName(value) || DEFAULT_DIR_NAME)
		.catch(DEFAULT_DIR_NAME),
});

// Renaming needs a real name: a missing, invalid or empty name is rejected.
export const renameDirectorySchema = z.object({
	newDirName: z
		.string("Valid directory name is required")
		.transform(sanitizeDirName)
		.refine((value) => value.length > 0, "Valid directory name is required"),
});
