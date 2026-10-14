//* src/services/user.service.js

import { randomBytes } from "node:crypto";

import User from "../models/user.model.js";
import AppError from "../errors/AppError.js";

import {
	buildProfilePictureKey,
	presignGet,
	putObject,
	deleteObject,
	PROFILE_PICTURE_URL_TTL_SECONDS,
} from "../lib/r2.js";
import { detectImageType } from "../utils/mimeType.js";

import envConfig from "../constants/env.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";

const { NOT_FOUND, BAD_REQUEST } = httpStatus;
const {
	USER_NOT_FOUND,
	INVALID_IMAGE_TYPE,
	IMAGE_TOO_LARGE,
	UPLOAD_INCOMPLETE,
	INVALID_INPUT,
} = appErrorCode;

const { MAX_PROFILE_PICTURE_SIZE } = envConfig;

const PROFILE_PICTURE_CACHE_CONTROL = `private, max-age=${PROFILE_PICTURE_URL_TTL_SECONDS}`;
const ALLOWED_PROFILE_PICTURE_TYPES = Object.freeze([
	"image/jpeg",
	"image/png",
	"image/webp",
]);

const removeProfilePictureObject = async (objectKey, userId) => {
	try {
		await deleteObject(objectKey);
	} catch (error) {
		console.warn(
			`Failed to remove the profile picture object for user ${userId}: ${error.name} ${error.$metadata?.httpStatusCode ?? ""}`.trim(),
		);
	}
};

const validateProfilePictureHeaders = ({ contentType, contentLength }) => {
	const declaredType = contentType?.split(";")[0].trim().toLowerCase();

	if (!ALLOWED_PROFILE_PICTURE_TYPES.includes(declaredType)) {
		throw new AppError(
			"Unsupported image type. Use JPEG, PNG, or WEBP.",
			BAD_REQUEST,
			INVALID_IMAGE_TYPE,
		);
	}

	const declaredLength = Number(contentLength);

	if (!Number.isInteger(declaredLength) || declaredLength <= 0) {
		throw new AppError(
			"A positive Content-Length is required",
			BAD_REQUEST,
			INVALID_INPUT,
		);
	}

	if (declaredLength > MAX_PROFILE_PICTURE_SIZE) {
		throw new AppError(
			"Profile picture exceeds the size limit",
			BAD_REQUEST,
			IMAGE_TOO_LARGE,
		);
	}

	return { declaredType, declaredLength };
};

const detectVerifiedImageType = (buffer, declaredType) => {
	const detected = detectImageType(buffer);

	if (!detected || detected.mime !== declaredType) {
		throw new AppError(
			"Unsupported image type. Use JPEG, PNG, or WEBP.",
			BAD_REQUEST,
			INVALID_IMAGE_TYPE,
		);
	}

	return detected.mime;
};

const readProfilePictureBody = async (body, declaredLength) => {
	const chunks = [];
	let size = 0;

	for await (const chunk of body) {
		size += chunk.length;

		if (size > MAX_PROFILE_PICTURE_SIZE) {
			throw new AppError(
				"Profile picture exceeds the size limit",
				BAD_REQUEST,
				IMAGE_TOO_LARGE,
			);
		}

		chunks.push(chunk);
	}

	if (size !== declaredLength) {
		throw new AppError("Upload is incomplete", BAD_REQUEST, UPLOAD_INCOMPLETE);
	}

	return Buffer.concat(chunks);
};

export const updateProfile = async (userId, name) => {
	const user = await User.findByIdAndUpdate(
		userId,
		{ name },
		{ new: true, runValidators: true },
	)
		.select("-password -otp -otpExpiresAt")
		.lean();

	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	return user;
};

export const uploadProfilePicture = async (userId, body, headers = {}) => {
	const { declaredType, declaredLength } =
		validateProfilePictureHeaders(headers);

	const buffer = await readProfilePictureBody(body, declaredLength);
	const detectedType = detectVerifiedImageType(buffer, declaredType);

	const user = await User.findById(userId).select("profilePictureKey").lean();

	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	const key = buildProfilePictureKey(
		userId.toString(),
		randomBytes(16).toString("hex"),
	);

	await putObject(key, buffer, {
		contentType: detectedType,
		cacheControl: PROFILE_PICTURE_CACHE_CONTROL,
	});

	let updatedUser;

	try {
		updatedUser = await User.findByIdAndUpdate(
			userId,
			{ profilePictureKey: key },
			{ new: true, runValidators: true },
		)
			.select("-password -otp -otpExpiresAt")
			.lean();

		if (!updatedUser) {
			throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
		}
	} catch (error) {
		await removeProfilePictureObject(key, userId);
		throw error;
	}

	// Remove the old profile picture object if it exists and is different from the new one
	if (user.profilePictureKey && user.profilePictureKey !== key) {
		await removeProfilePictureObject(user.profilePictureKey, userId);
	}

	return updatedUser;
};

export const resolveProfilePictureUrl = async (user) => {
	const { profilePictureKey, profilePicture } = user ?? {};

	if (profilePictureKey) {
		try {
			return await presignGet(profilePictureKey, {
				inline: true,
				ttl: PROFILE_PICTURE_URL_TTL_SECONDS,
			});
		} catch (error) {
			console.warn(
				`Unsignable profile picture key for user ${user._id}: ${error.message}`,
			);

			return null;
		}
	}

	return profilePicture ?? null;
};

export const formatUser = async (user) => {
	if (!user) return user;

	const { profilePictureKey, ...safeUser } = user;
	const profilePictureUrl = await resolveProfilePictureUrl(user);

	return { ...safeUser, profilePictureUrl };
};
