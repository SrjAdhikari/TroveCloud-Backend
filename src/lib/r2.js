//* src/lib/r2.js

import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import AppError from "../errors/AppError.js";
import envConfig from "../constants/env.js";
import buildContentDisposition from "../utils/contentDisposition.js";
import {
	FIVE_MINUTES_SECONDS,
	ONE_HOUR_SECONDS,
	FIFTEEN_MINUTES_MS,
} from "../utils/date.js";

import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";

const { BAD_REQUEST } = httpStatus;
const { INVALID_INPUT } = appErrorCode;
const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } =
	envConfig;

// The SDK ships both timeouts disabled, so a stall would hang the caller.
const R2_CONNECTION_TIMEOUT_MS = 3000;
const R2_REQUEST_TIMEOUT_MS = 30000;

const r2Client = new S3Client({
	region: "auto",
	endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
	},

	// R2 rejects the SDK's default checksum headers on multipart and presigned PUTs.
	requestChecksumCalculation: "WHEN_REQUIRED",
	responseChecksumValidation: "WHEN_REQUIRED",
	requestHandler: {
		connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
		requestTimeout: R2_REQUEST_TIMEOUT_MS,
		throwOnRequestTimeout: true,
	},
});

const FILE_PREFIX = "files";
const PROFILE_PICTURE_PREFIX = "profile-pictures";

const UPLOAD_URL_TTL_SECONDS = FIVE_MINUTES_SECONDS;
const DOWNLOAD_URL_TTL_SECONDS = ONE_HOUR_SECONDS;
const PROFILE_PICTURE_URL_TTL_SECONDS = ONE_HOUR_SECONDS;
const SIGNING_WINDOW_MS = FIFTEEN_MINUTES_MS;
const MAX_DELETE_KEYS_PER_REQUEST = 1000;

const quantizedSigningDate = (ttlSeconds) => {
	const window = Math.min(SIGNING_WINDOW_MS, (ttlSeconds * 1000) / 4);

	return new Date(Math.floor(Date.now() / window) * window);
};

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const SAFE_EXTENSION_PATTERN = /^(\.[a-z0-9]+)?$/;

const FILE_KEY_PATTERN = new RegExp(
	`^${FILE_PREFIX}/[a-f0-9]{24}-[a-f0-9]{32}(\\.[a-z0-9]+)?$`,
);
const PROFILE_PICTURE_KEY_PATTERN = new RegExp(
	`^${PROFILE_PICTURE_PREFIX}/[a-f0-9]{24}-[a-f0-9]{32}$`,
);

const invalidKey = () =>
	new AppError("Invalid object key", BAD_REQUEST, INVALID_INPUT);

// Syntax check, never an authorization check: either shape passes here.
const assertKey = (key) => {
	if (
		typeof key !== "string" ||
		!(FILE_KEY_PATTERN.test(key) || PROFILE_PICTURE_KEY_PATTERN.test(key))
	) {
		throw invalidKey();
	}
	return key;
};

const buildFileKey = (fileId, nonce, extension = "") => {
	const id = String(fileId);

	if (!OBJECT_ID_PATTERN.test(id)) throw invalidKey();
	if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce))
		throw invalidKey();

	if (
		typeof extension !== "string" ||
		!SAFE_EXTENSION_PATTERN.test(extension)
	) {
		throw invalidKey();
	}

	return assertKey(`${FILE_PREFIX}/${id}-${nonce}${extension}`);
};

const buildProfilePictureKey = (userId, token) => {
	const owner = String(userId);

	if (!OBJECT_ID_PATTERN.test(owner)) throw invalidKey();
	if (typeof token !== "string" || !NONCE_PATTERN.test(token))
		throw invalidKey();

	return assertKey(`${PROFILE_PICTURE_PREFIX}/${owner}-${token}`);
};

// Both fields are mandatory: omitting the length does not error, it drops
// `content-length` from the signature and mints an unbounded upload URL.
const presignPut = async (key, { contentType, contentLength, ttl } = {}) => {
	if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
		throw new AppError(
			"Upload content length is required",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	if (typeof contentType !== "string" || contentType.length === 0) {
		throw new AppError(
			"Upload content type is required",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	return getSignedUrl(
		r2Client,
		new PutObjectCommand({
			Bucket: R2_BUCKET,
			Key: assertKey(key),
			ContentType: contentType,
			ContentLength: contentLength,
		}),
		{
			expiresIn: ttl ?? UPLOAD_URL_TTL_SECONDS,
			signableHeaders: new Set(["content-type"]),
		},
	);
};

// A presigned GET can include a content type and disposition, but the caller may omit them. The TTL is longer to allow a user to download a file after leaving the page.
const presignGet = async (
	key,
	{ fileName, inline = false, contentType, ttl } = {},
) => {
	const expiresIn = ttl ?? DOWNLOAD_URL_TTL_SECONDS;

	return getSignedUrl(
		r2Client,
		new GetObjectCommand({
			Bucket: R2_BUCKET,
			Key: assertKey(key),
			ResponseContentType: contentType,
			ResponseContentDisposition: buildContentDisposition(
				inline ? "inline" : "attachment",
				fileName,
			),
		}),
		{ expiresIn, signingDate: quantizedSigningDate(expiresIn) },
	);
};

// A 403 means a bad bucket or credentials, not an absent object — rethrow it.
const isNotFound = (error) =>
	error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404;

// Returns null when the key is absent, or an object with size and contentType when present
const getObjectMetadata = async (key) => {
	try {
		const result = await r2Client.send(
			new HeadObjectCommand({ Bucket: R2_BUCKET, Key: assertKey(key) }),
		);
		return { size: result.ContentLength, contentType: result.ContentType };
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
};

// Reads a byte range from an object. Returns null when the key is absent, or an
// empty buffer when the range is unsatisfiable. Throws on invalid ranges.
const readRange = async (key, start, end) => {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end < start
	) {
		throw new AppError("Invalid byte range", BAD_REQUEST, INVALID_INPUT);
	}

	try {
		const result = await r2Client.send(
			new GetObjectCommand({
				Bucket: R2_BUCKET,
				Key: assertKey(key),
				Range: `bytes=${start}-${end}`,
			}),
		);

		const chunks = [];
		for await (const chunk of result.Body ?? []) chunks.push(chunk);

		return Buffer.concat(chunks);
	} catch (error) {
		if (isNotFound(error)) return null;
		if (error?.$metadata?.httpStatusCode === 416) return Buffer.alloc(0);
		throw error;
	}
};

// Multipart, so it takes streams of unknown length (Drive import) as well as buffers.
const putObject = async (key, stream, { contentType, cacheControl } = {}) => {
	const upload = new Upload({
		client: r2Client,
		queueSize: 1,
		params: {
			Bucket: R2_BUCKET,
			Key: assertKey(key),
			Body: stream,
			ContentType: contentType,
			CacheControl: cacheControl,
		},
	});

	await upload.done();
};

const deleteObject = async (key) => {
	await r2Client.send(
		new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: assertKey(key) }),
	);
};

const deleteObjects = async (keys) => {
	if (!Array.isArray(keys)) {
		throw new AppError(
			"Object keys must be an array",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	if (keys.length === 0) return { deleted: [], errors: [] };

	// Validate all keys before sending any requests to avoid partial deletions.
	// De-duplicated first: a repeated key otherwise consumes chunk budget and is
	// reported deleted more than once.
	const validated = [...new Set(keys)].map((key) => assertKey(key));

	const deleted = [];
	const errors = [];

	for (let i = 0; i < validated.length; i += MAX_DELETE_KEYS_PER_REQUEST) {
		const chunk = validated.slice(i, i + MAX_DELETE_KEYS_PER_REQUEST);

		const result = await r2Client.send(
			new DeleteObjectsCommand({
				Bucket: R2_BUCKET,
				Delete: { Objects: chunk.map((Key) => ({ Key })) },
			}),
		);

		const chunkErrors = (result.Errors ?? []).map((entry) => ({
			key: entry.Key,
			code: entry.Code,
			message: entry.Message,
		}));
		const failed = new Set(chunkErrors.map((entry) => entry.key));

		// Derived as requested-minus-failed: a response that omits Deleted[] would
		// otherwise report nothing deleted while the objects are already gone.
		deleted.push(...chunk.filter((key) => !failed.has(key)));
		errors.push(...chunkErrors);
	}

	return { deleted, errors };
};

const listObjects = async (prefix, continuationToken) => {
	const result = await r2Client.send(
		new ListObjectsV2Command({
			Bucket: R2_BUCKET,
			Prefix: prefix,
			ContinuationToken: continuationToken,
		}),
	);

	return {
		keys: (result.Contents ?? []).map((object) => ({
			key: object.Key,
			size: object.Size,
			lastModified: object.LastModified,
		})),
		nextToken: result.NextContinuationToken,
	};
};

export {
	r2Client,
	FILE_PREFIX,
	PROFILE_PICTURE_PREFIX,
	FILE_KEY_PATTERN,
	PROFILE_PICTURE_KEY_PATTERN,
	NONCE_PATTERN,
	assertKey,
	buildFileKey,
	buildProfilePictureKey,
	presignPut,
	presignGet,
	getObjectMetadata,
	readRange,
	putObject,
	deleteObject,
	deleteObjects,
	listObjects,
	UPLOAD_URL_TTL_SECONDS,
	DOWNLOAD_URL_TTL_SECONDS,
	PROFILE_PICTURE_URL_TTL_SECONDS,
	MAX_DELETE_KEYS_PER_REQUEST,
};
