//* src/services/drive.service.js

import path from "node:path";
import { Readable, pipeline } from "node:stream";

import {
	assertUploadableFileName,
	uploadFileFromServer,
} from "./file.service.js";
import { createDirectory } from "./directory.service.js";

import {
	getDriveFileMetadata,
	downloadDriveFile,
	exportGoogleDoc,
	listDriveFolderChildren,
	GOOGLE_APPS_EXPORT_MAP,
} from "../lib/googleDrive.js";

import createByteCounter from "../utils/byteCounter.js";
import sanitizeInput from "../utils/sanitizeInput.js";

import envConfig from "../constants/env.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import AppError from "../errors/AppError.js";

const { MAX_FILE_UPLOAD_SIZE, MAX_DRIVE_IMPORT_SIZE } = envConfig;

const { BAD_REQUEST } = httpStatus;
const {
	DRIVE_ITEM_NOT_FOUND,
	DRIVE_IMPORT_FAILED,
	UNSUPPORTED_DRIVE_TYPE,
	DRIVE_IMPORT_LIMIT_EXCEEDED,
	STORAGE_LIMIT_EXCEEDED,
} = appErrorCode;

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";

// Conservative caps; tune later if real usage warrants it.
const MAX_DEPTH = 20;

/**
 * Strips HTML, pads short names, truncates long names, strips control chars
 * and path separators. `Directory.name` is bounded to [3, 50] in Mongoose —
 * this guarantees that.
 */
const sanitizeDirName = (name) => {
	// sanitizeInput strips HTML and coerces non-strings to "".
	let clean = sanitizeInput(name).replace(/[\r\n\t\\/]/g, "").trim();

	if (!clean) clean = "Imported folder";
	if (clean.length < 3) clean = (clean + "___").slice(0, 3);
	if (clean.length > 50) clean = clean.slice(0, 50);

	return clean;
};

/**
 * Strips HTML, then produces a filename that satisfies `File.name` (minlength 3,
 * no hard max in schema but we cap at 255 to mirror the manual-upload controller).
 * When `fallbackExt` is supplied (Google-native export), ensures the name carries
 * that extension — `uploadFileFromServer` rejects a name without one.
 */
const sanitizeFileName = (name, fallbackExt = "") => {
	// sanitizeInput strips HTML and coerces non-strings to "".
	let clean = path
		.basename(sanitizeInput(name))
		.replace(/[\r\n\t\\/]/g, "")
		.trim();
	if (!clean) clean = "untitled";

	if (fallbackExt && !clean.toLowerCase().endsWith(fallbackExt.toLowerCase())) {
		clean = `${clean}${fallbackExt}`;
	}

	if (clean.length < 3) clean = (clean + "___").slice(0, 3);
	if (clean.length > 255) clean = clean.slice(0, 255);

	return clean;
};

/**
 * Drains a Drive folder's children across all pages. Shortcuts are returned
 * inline; the per-item handler decides to reject them.
 */
const listAllChildren = async (accessToken, folderId) => {
	const children = [];
	let pageToken;

	do {
		const page = await listDriveFolderChildren(
			accessToken,
			folderId,
			pageToken,
		);

		children.push(...(page.files || []));
		pageToken = page.nextPageToken;
	} while (pageToken);

	return children;
};

/**
 * Streams a Drive file (regular download or Google-native export) into the
 * user's tree via the `uploadFileFromServer` service. Tracks bytes so the
 * aggregate cap can be enforced, and short-circuits early when the per-file
 * cap is known up front (regular files with a `size` in metadata).
 */
const streamFileIntoTrove = async (
	ctx,
	targetParentDirId,
	meta,
	displayName,
) => {
	const isGoogleNative = meta.mimeType.startsWith(GOOGLE_APPS_PREFIX);

	// Pre-flight size check for regular files.
	if (!isGoogleNative && meta.size) {
		const declaredSize = Number(meta.size);

		if (Number.isFinite(declaredSize)) {
			if (declaredSize > MAX_FILE_UPLOAD_SIZE) {
				throw new AppError(
					"File exceeds per-file size cap",
					BAD_REQUEST,
					DRIVE_IMPORT_LIMIT_EXCEEDED,
				);
			}

			if (ctx.totalBytes + declaredSize > MAX_DRIVE_IMPORT_SIZE) {
				throw new AppError(
					"Import exceeds aggregate size cap",
					BAD_REQUEST,
					DRIVE_IMPORT_LIMIT_EXCEEDED,
				);
			}
		}
	}

	// Before the download: a rejected name reads no bytes, so the transfer cap never charges it.
	assertUploadableFileName(displayName);

	const remainingBudget = MAX_DRIVE_IMPORT_SIZE - ctx.totalBytes;
	const counter = createByteCounter(MAX_FILE_UPLOAD_SIZE, remainingBudget);

	let response;
	if (isGoogleNative) {
		const mapping = GOOGLE_APPS_EXPORT_MAP[meta.mimeType];
		response = await exportGoogleDoc(ctx.accessToken, meta.id, mapping.mime);
	} else {
		response = await downloadDriveFile(ctx.accessToken, meta.id);
	}

	const webStream = Readable.fromWeb(response.body);
	const counted = pipeline(webStream, counter.stream, () => {});

	try {
		return await uploadFileFromServer(
			targetParentDirId,
			ctx.userId,
			displayName,
			counted,
			ctx.storageLimit,
			{ reclaim: !ctx.reclaimSpent },
		);
	} catch (error) {
		// The upload can reject before reading a byte, leaving the Drive socket open.
		counted.destroy();

		// After one quota rejection, later items skip the sweep; re-running it only repeats its lookups.
		if (error instanceof AppError && error.code === STORAGE_LIMIT_EXCEEDED) {
			ctx.reclaimSpent = true;
		}

		if (counter.state.tripped) {
			throw new AppError(
				"File exceeds size cap",
				BAD_REQUEST,
				DRIVE_IMPORT_LIMIT_EXCEEDED,
			);
		}
		throw error;
	} finally {
		// Rejected transfers count too, or a full account could move unbounded bytes in one request.
		ctx.totalBytes += counter.state.bytes;
	}
};

/**
 * Imports a single Drive item into the given parent directory, recursing into
 * folders. Emits results into `ctx.imported` / `ctx.failed`. Never throws to
 * the top level — every error is mapped to a `failed` entry so one bad item
 * doesn't abort the whole batch.
 */
const importItem = async (
	ctx,
	driveId,
	targetParentDirId,
	depth,
	knownMeta,
) => {
	// Dedup across the whole traversal — stops double-import when user picks folder A AND a file inside A
	if (ctx.seen.has(driveId)) return;
	ctx.seen.add(driveId);

	// Short-circuit once aggregate cap is hit — remaining items all fail fast with the same reason
	if (ctx.totalBytes >= MAX_DRIVE_IMPORT_SIZE) {
		ctx.failed.push({
			driveId,
			name: knownMeta?.name ?? null,
			reason: DRIVE_IMPORT_LIMIT_EXCEEDED,
		});
		return;
	}

	// Guard against pathologically deep folder trees (malicious or accidental)
	if (depth > MAX_DEPTH) {
		ctx.failed.push({
			driveId,
			name: knownMeta?.name ?? null,
			reason: DRIVE_IMPORT_FAILED,
		});
		return;
	}

	let meta;

	try {
		// Client-supplied mimeType from the Picker is spoofable; re-fetch for top-level.
		// Children come from our own list call and are already trustworthy.
		meta = knownMeta ?? (await getDriveFileMetadata(ctx.accessToken, driveId));

		// Check if the file is trashed, if so, add it to the failed list and return
		if (meta.trashed) {
			ctx.failed.push({
				driveId,
				name: meta.name,
				reason: DRIVE_ITEM_NOT_FOUND,
			});
			return;
		}

		// Check if the file is a shortcut, if so, add it to the failed list and return
		if (meta.mimeType === SHORTCUT_MIME) {
			ctx.failed.push({
				driveId,
				name: meta.name,
				reason: UNSUPPORTED_DRIVE_TYPE,
			});
			return;
		}

		// Handle folders - recursively import children if the item is a folder
		if (meta.mimeType === FOLDER_MIME) {
			const folderName = sanitizeDirName(meta.name);
			const created = await createDirectory(
				targetParentDirId,
				folderName,
				ctx.userId,
			);
			ctx.imported.push({
				driveId: meta.id,
				troveId: created._id.toString(),
				name: folderName,
				kind: "folder",
			});

			// Recursively import children
			const children = await listAllChildren(ctx.accessToken, meta.id);
			for (const child of children) {
				await importItem(
					ctx,
					child.id,
					created._id.toString(),
					depth + 1,
					child,
				);
			}
			return;
		}

		// Handle Google Workspace files (Docs, Sheets, Slides) - convert and upload
		if (meta.mimeType.startsWith(GOOGLE_APPS_PREFIX)) {
			const mapping = GOOGLE_APPS_EXPORT_MAP[meta.mimeType];
			if (!mapping) {
				ctx.failed.push({
					driveId: meta.id,
					name: meta.name,
					reason: UNSUPPORTED_DRIVE_TYPE,
				});
				return;
			}

			const displayName = sanitizeFileName(meta.name, mapping.ext);
			const uploaded = await streamFileIntoTrove(
				ctx,
				targetParentDirId,
				meta,
				displayName,
			);

			ctx.imported.push({
				driveId: meta.id,
				troveId: uploaded._id.toString(),
				name: displayName,
				kind: "file",
			});
			return;
		}

		// Regular binary file
		const displayName = sanitizeFileName(meta.name);
		const uploaded = await streamFileIntoTrove(
			ctx,
			targetParentDirId,
			meta,
			displayName,
		);

		ctx.imported.push({
			driveId: meta.id,
			troveId: uploaded._id.toString(),
			name: displayName,
			kind: "file",
		});
	} catch (error) {
		// Partial-success contract: one bad item never aborts the whole batch.
		// Preserve the specific AppError code when we have one; otherwise fall back to generic.
		const reason =
			error instanceof AppError && error.code
				? error.code
				: DRIVE_IMPORT_FAILED;
		ctx.failed.push({
			driveId,
			name: meta?.name ?? knownMeta?.name ?? null,
			reason,
		});
	}
};

/**
 * Orchestrates a one-shot import of picked Drive items into the authenticated
 * user's tree. Returns a partial-success report; HTTP status is always 200
 * unless the controller-layer input validation fails — per-item errors,
 * including an unusable `storageLimit`, land in `failed[]`.
 *
 * @param {string} userId
 * @param {string} accessToken - Short-lived Drive token (scope: drive.readonly).
 * @param {Array<{id:string, mimeType:string, name?:string}>} items
 * @param {string} parentDirId - Resolved target directory (controller defaults to user.rootDirId).
 * @param {number} storageLimit - The user's quota in bytes, enforced per imported file.
 * @returns {Promise<{imported:Array, failed:Array}>}
 */
const importFromDrive = async (
	userId,
	accessToken,
	items,
	parentDirId,
	storageLimit,
) => {
	// Context for the batch import - holds state across sequential imports
	const ctx = {
		userId,
		accessToken,
		storageLimit,
		totalBytes: 0,
		reclaimSpent: false,
		imported: [],
		failed: [],
		seen: new Set(),
	};

	// Remove duplicates from the picker input - if the user selected the same file twice,
	// we'd otherwise try to import (and store) it twice
	const uniqueItems = [];
	const topLevelSeen = new Set();

	for (const item of items) {
		if (topLevelSeen.has(item.id)) continue;
		topLevelSeen.add(item.id);
		uniqueItems.push(item);
	}

	// Sequential (not Promise.all) to stay under Drive's 1000-req/100s/user quota.
	// Parallelize with p-limit later if p95 latency becomes a problem.
	for (const item of uniqueItems) {
		await importItem(ctx, item.id, parentDirId, 0, null);
	}

	return { imported: ctx.imported, failed: ctx.failed };
};

export { importFromDrive, sanitizeDirName, sanitizeFileName };
