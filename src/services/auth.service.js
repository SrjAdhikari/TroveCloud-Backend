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

// Also creates the user's root folder.
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

// Sends a new sign-up code that replaces the old one.
// Users must wait one minute between codes, so nobody can flood an inbox or overuse our email service.
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

// Only works for accounts that sign in with email and password.
// The reset code is saved in the same place as the sign-up code, since that one is no longer needed after sign-up.
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

// Logs out every device, so whoever started the reset is kicked out too.
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

export const loginOrCreateGithubUser = async (code, deviceInfo) => {
	const profile = await verifyGithubCodeAndFetchProfile(code);
	return loginOrCreateOAuthUser("github", profile, deviceInfo);
};

export const logoutUser = async (sessionId) => {
	if (sessionId) {
		await Session.deleteOne({ _id: sessionId });
	}
};

export const logoutAllUser = async (userId) => {
	if (userId) {
		await Session.deleteMany({ userId });
	}
};
