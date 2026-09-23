//* src/routes/file.routes.js

/**
 * File Routes
 * @module routes/file
 */

import { Router } from "express";
import {
	getFileHandler,
	createDownloadUrlHandler,
	initiateUploadHandler,
	confirmUploadHandler,
	cancelUploadHandler,
	updateFileHandler,
	deleteFileHandler,
} from "../controllers/file.controller.js";

import authenticate from "../middlewares/auth.middleware.js";
import {
	validateBody,
	validateId,
} from "../middlewares/validate.middleware.js";
import {
	uploadLimiter,
	readLimiter,
	mutationLimiter,
	destructiveLimiter,
} from "../middlewares/rateLimit.middleware.js";
import {
	initiateUploadSchema,
	renameFileSchema,
} from "../validators/file.validator.js";

const fileRouter = Router();

// All file routes require authentication
fileRouter.use(authenticate);

// Validate ID parameters
["id", "parentDirId"].forEach((param) => {
	fileRouter.param(param, validateId);
});

/**
 * Initiate an upload: reserve quota and return a presigned URL
 * @route POST /api/files/{:parentDirId}
 */
fileRouter.post(
	"{/:parentDirId}",
	uploadLimiter,
	validateBody(initiateUploadSchema),
	initiateUploadHandler,
);

/**
 * Confirm a completed upload
 * @route POST /api/files/{:id}/confirm
 */
fileRouter.post("/:id/confirm", mutationLimiter, confirmUploadHandler);

/**
 * Cancel a pending upload
 * @route POST /api/files/{:id}/cancel
 */
fileRouter.post("/:id/cancel", mutationLimiter, cancelUploadHandler);

/**
 * Mint a signed download URL for a file
 * @route GET /api/files/{:id}/download-url
 */
fileRouter.get("/:id/download-url", readLimiter, createDownloadUrlHandler);

/**
 * Get a file by id
 * @route GET /api/files/{:id}
 */
fileRouter.get("/:id", readLimiter, getFileHandler);

/**
 * Update (Rename) a file
 * @route PATCH /api/files/{:id}
 */
fileRouter.patch(
	"/:id",
	mutationLimiter,
	validateBody(renameFileSchema),
	updateFileHandler,
);

/**
 * Delete a file
 * @route DELETE /api/files/{:id}
 */
fileRouter.delete("/:id", destructiveLimiter, deleteFileHandler);

export default fileRouter;
