//* src/lib/googleDrive.js

import envConfig from "../constants/env.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";

import AppError from "../errors/AppError.js";

const { BAD_REQUEST, NOT_FOUND } = httpStatus;
const {
	INVALID_DRIVE_TOKEN,
	DRIVE_ITEM_NOT_FOUND,
	DRIVE_EXPORT_TOO_LARGE,
	DRIVE_IMPORT_FAILED,
} = appErrorCode;
const { NODE_ENV } = envConfig;

// Drive API constants
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_FETCH_TIMEOUT_MS = 15000;
const DRIVE_USER_AGENT = "TroveCloud";

/**
 * Mime-type lookup for Google-native files that need conversion on import.
 * Unmapped google-apps types (Forms, Drawings, Jamboards, Sites, Shortcuts)
 * are rejected as UNSUPPORTED_DRIVE_TYPE by the service layer.
 */
export const GOOGLE_APPS_EXPORT_MAP = Object.freeze({
	"application/vnd.google-apps.document": {
		mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		ext: ".docx",
	},
	"application/vnd.google-apps.spreadsheet": {
		mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		ext: ".xlsx",
	},
	"application/vnd.google-apps.presentation": {
		mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		ext: ".pptx",
	},
});

const buildAuthHeaders = (accessToken) => ({
	Authorization: `Bearer ${accessToken}`,
	Accept: "application/json",
	"User-Agent": DRIVE_USER_AGENT,
});

const buildStreamHeaders = (accessToken) => ({
	Authorization: `Bearer ${accessToken}`,
	"User-Agent": DRIVE_USER_AGENT,
});

/**
 * Extracts Google's machine-readable error reason from a non-2xx Drive response.
 * Safe to call even if the body is not JSON — returns "" on parse failure.
 */
const parseDriveErrorReason = async (response) => {
	try {
		const body = await response.json();
		return body?.error?.errors?.[0]?.reason || "";
	} catch {
		return "";
	}
};

/**
 * Maps an unsuccessful Drive HTTP response to an AppError.
 * Called only after a `response.ok === false` check. Never echoes the access token.
 */
const mapDriveResponseError = async (response) => {
	if (response.status === 401) {
		return new AppError(
			"Invalid Drive access token",
			BAD_REQUEST,
			INVALID_DRIVE_TOKEN,
		);
	}

	if (response.status === 404) {
		return new AppError(
			"Drive item not found",
			NOT_FOUND,
			DRIVE_ITEM_NOT_FOUND,
		);
	}

	if (response.status === 403) {
		const reason = await parseDriveErrorReason(response);
		if (reason === "exportSizeLimitExceeded") {
			return new AppError(
				"Drive export exceeds Google's 10 MB export limit",
				BAD_REQUEST,
				DRIVE_EXPORT_TOO_LARGE,
			);
		}
	}

	return new AppError("Drive request failed", BAD_REQUEST, DRIVE_IMPORT_FAILED);
};

/**
 * Unified catch for Drive calls. Re-throws AppError as-is; wraps anything else
 * (network errors, JSON parse errors, aborts) as DRIVE_IMPORT_FAILED.
 * Dev-mode logging is redacted — access tokens never hit stdout.
 */
const handleDriveFetchError = (error, operation) => {
	if (error instanceof AppError) throw error;

	if (NODE_ENV !== "production") {
		console.error(
			`[googleDrive] ${operation} underlying error:`,
			error?.message || error,
		);
	}

	throw new AppError("Drive request failed", BAD_REQUEST, DRIVE_IMPORT_FAILED);
};

/**
 * Fetches authoritative metadata for a single Drive file or folder.
 * Client-supplied mimeType from the Picker is not trusted;
 * callers should re-fetch via this function before branching on type.
 *
 * @param {string} accessToken - Short-lived OAuth token (drive.readonly scope).
 * @param {string} fileId - Drive file or folder ID.
 *
 * @returns {Promise<{id:string, name:string, mimeType:string, size?:string, trashed?:boolean, shortcutDetails?:Object, parents?:string[]}>}
 * @throws {AppError} INVALID_DRIVE_TOKEN / DRIVE_ITEM_NOT_FOUND / DRIVE_IMPORT_FAILED
 */
export const getDriveFileMetadata = async (accessToken, fileId) => {
	try {
		const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);

		url.searchParams.set(
			"fields",
			"id,name,mimeType,size,parents,trashed,shortcutDetails",
		);
		url.searchParams.set("supportsAllDrives", "true");

		const response = await fetch(url, {
			headers: buildAuthHeaders(accessToken),
			signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw await mapDriveResponseError(response);
		}

		return await response.json();
	} catch (error) {
		handleDriveFetchError(error, "getDriveFileMetadata");
	}
};

/**
 * Initiates a binary download of a regular (non-Google-native) Drive file.
 * Returns the raw fetch Response so the caller can stream `response.body` as a Web ReadableStream.
 *
 * @param {string} accessToken
 * @param {string} fileId
 * @returns {Promise<Response>}
 */
export const downloadDriveFile = async (accessToken, fileId) => {
	try {
		const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);

		url.searchParams.set("alt", "media");
		url.searchParams.set("supportsAllDrives", "true");

		const response = await fetch(url, {
			headers: buildStreamHeaders(accessToken),
			signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw await mapDriveResponseError(response);
		}

		return response;
	} catch (error) {
		handleDriveFetchError(error, "downloadDriveFile");
	}
};

/**
 * Exports a Google-native file (Doc/Sheet/Slides) to an Office format.
 * Returns the raw fetch Response so the caller can stream `response.body`.
 *
 * @param {string} accessToken
 * @param {string} fileId
 * @param {string} exportMimeType - One of the target mimes in GOOGLE_APPS_EXPORT_MAP.
 *
 * @returns {Promise<Response>}
 * @throws {AppError} DRIVE_EXPORT_TOO_LARGE for >= 10 MB Docs/Slides.
 */
export const exportGoogleDoc = async (accessToken, fileId, exportMimeType) => {
	try {
		const url = new URL(
			`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/export`,
		);

		url.searchParams.set("mimeType", exportMimeType);

		const response = await fetch(url, {
			headers: buildStreamHeaders(accessToken),
			signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw await mapDriveResponseError(response);
		}

		return response;
	} catch (error) {
		handleDriveFetchError(error, "exportGoogleDoc");
	}
};

/**
 * Lists one page of children inside a Drive folder.
 * Server-side filter excludes trashed items.
 * Callers handle pagination by re-calling with `nextPageToken` until it's undefined.
 *
 * @param {string} accessToken
 * @param {string} folderId
 * @param {string} [pageToken]
 *
 * @returns {Promise<{files: Array<{id:string,name:string,mimeType:string,size?:string}>, nextPageToken?:string}>}
 */
export const listDriveFolderChildren = async (accessToken, folderId, pageToken) => {
	try {
		const url = new URL(DRIVE_FILES_URL);

		url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
		url.searchParams.set(
			"fields",
			"nextPageToken,files(id,name,mimeType,size)",
		);
		url.searchParams.set("pageSize", "100");
		url.searchParams.set("supportsAllDrives", "true");
		url.searchParams.set("includeItemsFromAllDrives", "true");

		if (pageToken) url.searchParams.set("pageToken", pageToken);

		const response = await fetch(url, {
			headers: buildAuthHeaders(accessToken),
			signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw await mapDriveResponseError(response);
		}

		return await response.json();
	} catch (error) {
		handleDriveFetchError(error, "listDriveFolderChildren");
	}
};
