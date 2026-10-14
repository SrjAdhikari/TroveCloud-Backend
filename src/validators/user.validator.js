//* src/validators/user.validator.js

import { z } from "zod";
import sanitizeInput from "../utils/sanitizeInput.js";

const name = z
	.string()
	.trim()
	.transform(sanitizeInput)
	.refine(
		(value) => value.length >= 3 && value.length <= 50,
		"Name is required and must be between 3 and 50 characters",
	);

export const updateProfileSchema = z.object({ name });
