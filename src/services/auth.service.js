//* src/services/auth.service.js

import mongoose from "mongoose";

import User from "../models/user.model.js";
import Session from "../models/session.model.js";
import Directory from "../models/directory.model.js";

import AppError from "../errors/AppError.js";

import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";

import {
	ONE_MINUTE_MS,
	tenMinutesFromNow,
	oneHourFromNow,
} from "../utils/date.js";
import verifyGoogleIdToken from "../lib/googleAuth.js";
import verifyGithubCodeAndFetchProfile from "../lib/githubAuth.js";

import {
	generateOTP,
	isValidOTP,
	sendOTP,
	sendPasswordResetOTP,
	issueOTPToUser,
	isOTPExpired,
	isOTPCooldownActive,
} from "./otp.service.js";
import { loginOrCreateOAuthUser } from "./oauth.service.js";
import { enforceDeviceLimit } from "./session.service.js";

const {
	CONFLICT,
	NOT_FOUND,
	BAD_REQUEST,
	UNAUTHORIZED,
	FORBIDDEN,
	TOO_MANY_REQUESTS,
} = httpStatus;

const {
	USER_ALREADY_EXISTS,
	USER_NOT_FOUND,
	INVALID_OTP,
	OTP_EXPIRED,
	OTP_COOLDOWN,
	INVALID_CREDENTIALS,
	USER_NOT_VERIFIED,
	PROVIDER_MISMATCH,
	PASSWORD_REUSE,
	GOOGLE_EMAIL_NOT_VERIFIED,
	UNAUTHORIZED_ACCESS,
	ACCOUNT_SUSPENDED,
} = appErrorCode;

/**
 * Resolves user registration including unverified user re-registration edge-cases.
 * Generates OTP and updates auto-deletion limits before dispatching the email.
 *
 * @param {string} name - The user's full name
 * @param {string} email - The user's email address
 * @param {string} password - The user's unhashed password
 * @throws {AppError} If the user already exists and is fully verified
 */
export const createUser = async (name, email, password) => {
	const user = await User.findOne({ email });

	if (user && user.isVerified) {
		throw new AppError("User already exists", CONFLICT, USER_ALREADY_EXISTS);
	}

	const { plainOTP, hashedOTP } = generateOTP();

	// Unverified user re-registering — update OTP fields and extend TTL
	if (user) {
		user.name = name;
		user.password = password;
		user.otp = hashedOTP;
		user.otpExpiresAt = tenMinutesFromNow();
		user.verificationExpiresAt = oneHourFromNow();
		await user.save();
	} else {
		await User.create({
			name,
			email,
			password,
			otp: hashedOTP,
			otpExpiresAt: tenMinutesFromNow(),
			verificationExpiresAt: oneHourFromNow(),
		});
	}

	await sendOTP(name, email, plainOTP);
};

/**
 * Verifies a 6-digit OTP to finalize account registration.
 * Executes within a MongoDB transaction to sequentially mark the user
 * as verified and generate their default root directory.
 *
 * @param {string} email - The user's email address
 * @param {string} otp - The raw 6-digit OTP string
 * @returns {Promise<Object>} The verified user document
 * @throws {AppError} If the user is missing, or the OTP is invalid/expired
 */
export const verifyOTP = async (email, otp) => {
	const user = await User.findOne({ email, isVerified: false }).select(
		"+otp +otpExpiresAt",
	);

	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	if (isOTPExpired(user.otpExpiresAt)) {
		throw new AppError("OTP has expired", BAD_REQUEST, OTP_EXPIRED);
	}

	if (!isValidOTP(otp, user.otp)) {
		throw new AppError("Invalid OTP", BAD_REQUEST, INVALID_OTP);
	}

	const session = await mongoose.startSession();
	const rootDirId = new mongoose.Types.ObjectId();

	// Run in a transaction: if the directory fails to create, the user's
	// verification state rolls back automatically, preventing orphaned states.
	try {
		await session.withTransaction(async () => {
			await Directory.create(
				[
					{
						_id: rootDirId,
						name: `root-${email}`,
						userId: user._id,
						parentDirId: null,
					},
				],
				{ session },
			);

			user.isVerified = true;
			user.rootDirId = rootDirId;
			user.otp = undefined;
			user.otpExpiresAt = undefined;
			user.verificationExpiresAt = undefined;

			await user.save({ session });
		});
	} finally {
		await session.endSession();
	}
};

/**
 * Resends a fresh verification OTP while enforcing a strict 60-second cooldown
 * to prevent email spamming on the external mailing service.
 *
 * @param {string} email - The unverified user's email address
 * @throws {AppError} If cooldown is active, user is missing, or user is already verified
 */
export const resendOTP = async (email) => {
	const user = await User.findOne({ email }).select("+otpExpiresAt");

	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	if (user.isVerified) {
		throw new AppError("User already exists", CONFLICT, USER_ALREADY_EXISTS);
	}

	if (isOTPCooldownActive(user.otpExpiresAt, ONE_MINUTE_MS)) {
		throw new AppError(
			"Please wait before requesting a new OTP",
			TOO_MANY_REQUESTS,
			OTP_COOLDOWN,
		);
	}

	const plainOTP = await issueOTPToUser(user);
	await sendOTP(user.name, email, plainOTP);
};

/**
 * Issues a password reset OTP to a verified email-provider user.
 * Reuses the User document's `otp` / `otpExpiresAt` fields (idle once a user
 * is verified) instead of adding parallel reset-specific fields.
 *
 * @param {string} email - The user's email address
 * @throws {AppError} If the user is missing/unverified, signed in via OAuth, or the cooldown is active
 */
export const forgotPassword = async (email) => {
	const user = await User.findOne({ email, isVerified: true }).select(
		"+otpExpiresAt",
	);

	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	// OAuth-provisioned users have no password — sending a reset code would be
	// useless and confusing. Steer them to their actual sign-in method.
	if (user.provider !== "email") {
		throw new AppError(
			`Please sign in with ${user.provider}`,
			BAD_REQUEST,
			PROVIDER_MISMATCH,
		);
	}

	if (isOTPCooldownActive(user.otpExpiresAt, ONE_MINUTE_MS)) {
		throw new AppError(
			"Please wait before requesting a new OTP",
			TOO_MANY_REQUESTS,
			OTP_COOLDOWN,
		);
	}

	const plainOTP = await issueOTPToUser(user);
	await sendPasswordResetOTP(user.name, email, plainOTP);
};

/**
 * Verifies a password reset OTP and persists the new password.
 *
 * @NOTE: The Mongoose pre-save hook re-hashes the password;
 * the schema's `minlength: 8` enforces strength (the global
 * error handler maps the ValidationError to 422).
 *
 * @NOTE: All sessions are invalidated on success so an attacker who triggered
 * the reset is logged out everywhere alongside the legitimate user.
 *
 * @param {string} email - The user's email address
 * @param {string} otp - The raw 6-digit reset code
 * @param {string} newPassword - The user's chosen new password
 * @throws {AppError} If the user is missing/unverified, signed in via OAuth, or the OTP is invalid/expired
 */
export const resetPassword = async (email, otp, newPassword) => {
	const user = await User.findOne({ email, isVerified: true }).select(
		"+otp +otpExpiresAt",
	);

	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	if (user.provider !== "email") {
		throw new AppError(
			`Please sign in with ${user.provider}`,
			BAD_REQUEST,
			PROVIDER_MISMATCH,
		);
	}

	if (isOTPExpired(user.otpExpiresAt)) {
		throw new AppError("OTP has expired", BAD_REQUEST, OTP_EXPIRED);
	}

	if (!isValidOTP(otp, user.otp)) {
		throw new AppError("Invalid OTP", BAD_REQUEST, INVALID_OTP);
	}

	const session = await mongoose.startSession();

	// Run in a transaction: if the session wipe fails, the password change
	// rolls back so the user can retry the reset cleanly with the same OTP
	// instead of being left in a half-applied state.
	try {
		await session.withTransaction(async () => {
			user.password = newPassword;
			user.otp = undefined;
			user.otpExpiresAt = undefined;

			await user.save({ session });
			await Session.deleteMany({ userId: user._id }, { session });
		});
	} finally {
		await session.endSession();
	}
};

/**
 * Changes the authenticated user's password after verifying the current one,
 * then revokes every other active session (the current device stays signed in).
 *
 * @param {string} userId - Authenticated user's id (req.user._id).
 * @param {string} currentPassword - The raw current-password attempt.
 * @param {string} newPassword - The validated new password.
 * @param {string} currentSessionId - The current session's id (req.sessionId); preserved.
 * @returns {Promise<void>}
 * @throws {AppError} USER_NOT_FOUND | PROVIDER_MISMATCH | INVALID_CREDENTIALS | PASSWORD_REUSE.
 */
export const changePassword = async (
	userId,
	currentPassword,
	newPassword,
	currentSessionId,
) => {
	const user = await User.findById(userId).select("+password");

	if (!user) {
		throw new AppError("User not found", NOT_FOUND, USER_NOT_FOUND);
	}

	// OAuth accounts have no password to change.
	if (user.provider !== "email") {
		throw new AppError(
			`Password change is not available for accounts created with ${user.provider}`,
			BAD_REQUEST,
			PROVIDER_MISMATCH,
		);
	}

	const isCurrentPasswordValid = await user.comparePassword(currentPassword);
	if (!isCurrentPasswordValid) {
		throw new AppError(
			"Current password is incorrect",
			UNAUTHORIZED,
			INVALID_CREDENTIALS,
		);
	}

	if (newPassword === currentPassword) {
		throw new AppError(
			"New password must be different from the current password",
			BAD_REQUEST,
			PASSWORD_REUSE,
		);
	}

	const session = await mongoose.startSession();

	// Transaction: if the other-session wipe fails, the password change rolls
	// back so the user is never left half-updated.
	try {
		await session.withTransaction(async () => {
			user.password = newPassword; // pre-save hook bcrypt-hashes it
			await user.save({ session });

			// Revoke every other session; the current device stays signed in.
			await Session.deleteMany(
				{ userId: user._id, _id: { $ne: currentSessionId } },
				{ session },
			);
		});
	} finally {
		await session.endSession();
	}
};

/**
 * Unlocks an account by verifying passwords and creating a secure session.
 * Tracks active devices to enforce concurrency limits.
 *
 * @param {string} email - The user's email
 * @param {string} password - The raw password attempt
 * @param {Object} deviceInfo - Rich parsed metrics about the requester's device
 * @returns {Promise<Object>} The generated session document
 * @throws {AppError} If credentials fail or the user is unverified
 */
export const loginUser = async (email, password, deviceInfo) => {
	const user = await User.findOne({ email }).select("+password");

	if (!user) {
		throw new AppError(
			"Invalid credentials",
			UNAUTHORIZED,
			INVALID_CREDENTIALS,
		);
	}

	// OAuth-provisioned users have no password — reject before bcrypt tries
	// to compare against an undefined hash (would throw a raw bcrypt error).
	if (user.provider !== "email") {
		throw new AppError(
			`Please sign in with ${user.provider}`,
			BAD_REQUEST,
			PROVIDER_MISMATCH,
		);
	}

	if (!user.isVerified) {
		throw new AppError(
			"Please verify your email first",
			BAD_REQUEST,
			USER_NOT_VERIFIED,
		);
	}

	// Reject locked-out accounts before confirming credentials
	if (user.deletedAt) {
		throw new AppError(
			"Account no longer exists",
			UNAUTHORIZED,
			UNAUTHORIZED_ACCESS,
		);
	}

	if (user.suspendedAt) {
		throw new AppError("Account is suspended", FORBIDDEN, ACCOUNT_SUSPENDED);
	}

	const isPasswordValid = await user.comparePassword(password);

	if (!isPasswordValid) {
		throw new AppError(
			"Invalid credentials",
			UNAUTHORIZED,
			INVALID_CREDENTIALS,
		);
	}

	await enforceDeviceLimit(user._id);

	const session = await Session.create({
		userId: user._id,
		deviceInfo,
	});

	return session;
};

/**
 * Signs a user in with a Google ID token.
 * Verifies the token, enforces the `email_verified` claim, then delegates
 * to the shared OAuth helper for user lookup/creation and session issuance.
 *
 * @param {string} idToken - Google ID token supplied by the client.
 * @param {Object} deviceInfo - Parsed device metadata attached to the new session.
 * @returns {Promise<{ session: Object, isNewUser: boolean }>} The issued session and whether a new account was created.
 *
 * @throws {AppError} `INVALID_ID_TOKEN` — the token is invalid or malformed.
 * @throws {AppError} `GOOGLE_EMAIL_NOT_VERIFIED` — Google has not verified the email on the account.
 */
export const loginOrCreateGoogleUser = async (idToken, deviceInfo) => {
	const payload = await verifyGoogleIdToken(idToken);
	const { name, email, picture, email_verified: emailVerified } = payload;

	if (!emailVerified) {
		throw new AppError(
			"Google has not verified this email address",
			BAD_REQUEST,
			GOOGLE_EMAIL_NOT_VERIFIED,
		);
	}

	return loginOrCreateOAuthUser("google", { name, email, picture }, deviceInfo);
};

/**
 * Signs a user in with a GitHub OAuth authorization code.
 * Exchanges the code for a verified profile, then delegates to the shared
 * OAuth helper for user lookup/creation and session issuance.
 *
 * @param {string} code - GitHub authorization code supplied by the client.
 * @param {Object} deviceInfo - Parsed device metadata attached to the new session.
 * @returns {Promise<{ session: Object, isNewUser: boolean }>} The issued session and whether a new account was created.

 * @throws {AppError} `INVALID_GITHUB_CODE` — the code is invalid, expired, or the GitHub API call failed.
 * @throws {AppError} `GITHUB_EMAIL_NOT_VERIFIED` — the account has no verified primary email.
 */
export const loginOrCreateGithubUser = async (code, deviceInfo) => {
	const profile = await verifyGithubCodeAndFetchProfile(code);
	return loginOrCreateOAuthUser("github", profile, deviceInfo);
};

/**
 * Destroys a single specific session to log a user out of their current device.
 *
 * @param {string} sessionId - The specific session to delete
 * @returns {Promise<void>}
 */
export const logoutUser = async (sessionId) => {
	if (sessionId) {
		await Session.deleteOne({ _id: sessionId });
	}
};

/**
 * Destroys all active sessions for a user, forcing a global logout across all devices.
 *
 * @param {string} userId - The unique identifier of the user
 * @returns {Promise<void>}
 */
export const logoutAllUser = async (userId) => {
	if (userId) {
		await Session.deleteMany({ userId });
	}
};
