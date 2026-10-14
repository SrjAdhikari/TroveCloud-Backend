//* src/services/otp.service.js

import crypto from "crypto";
import sendEmail from "../lib/sendEmail.js";
import {
	VERIFY_EMAIL_TEMPLATE,
	PASSWORD_RESET_EMAIL_TEMPLATE,
} from "../templates/emails/index.js";
import { TEN_MINUTES_MS, tenMinutesFromNow } from "../utils/date.js";

/**
 * Generates a cryptic 6-digit OTP alongside a SHA-256 hashed version
 * @returns {{ plainOTP: string, hashedOTP: string }}
 */
export const generateOTP = () => {
	const plainOTP = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
	const hashedOTP = crypto.createHash("sha256").update(plainOTP).digest("hex");

	return { plainOTP, hashedOTP };
};

/**
 * Prevents timing attacks while securely verifying a user-provided OTP
 * against the database's SHA-256 hashed OTP.
 *
 * @param {string} inputOTP - The raw OTP to verify
 * @param {string} storedHash - The hashed OTP retrieved from MongoDB
 * @returns {boolean} True if the OTP is perfectly valid
 */
export const isValidOTP = (inputOTP, storedHash) => {
	const inputHash = crypto
		.createHash("sha256")
		.update(String(inputOTP))
		.digest();
	const stored = Buffer.from(storedHash, "hex");

	if (inputHash.length !== stored.length) return false;
	return crypto.timingSafeEqual(inputHash, stored);
};

/**
 * Sends a verification OTP to the user's email
 *
 * @param {string} name - The user's name
 * @param {string} email - The user's email address
 * @param {string} otp - The 6-digit OTP
 */
export const sendOTP = async (name, email, otp) => {
	await sendEmail(
		email,
		"Verify your email address",
		VERIFY_EMAIL_TEMPLATE(name, otp),
	);
};

/**
 * Sends a password reset OTP to the user's email
 *
 * @param {string} name - The user's name
 * @param {string} email - The user's email address
 * @param {string} otp - The 6-digit OTP
 */
export const sendPasswordResetOTP = async (name, email, otp) => {
	await sendEmail(
		email,
		"Reset your password",
		PASSWORD_RESET_EMAIL_TEMPLATE(name, otp),
	);
};

/**
 * Generates a fresh OTP, persists the hash + 10-minute expiry on the user document.
 *
 * @param {Object} user - The user document to update
 * @returns {Promise<string>} The plain OTP
 */
export const issueOTPToUser = async (user) => {
	const { plainOTP, hashedOTP } = generateOTP();

	user.otp = hashedOTP;
	user.otpExpiresAt = tenMinutesFromNow();
	await user.save();

	return plainOTP;
};

/**
 * Checks if the OTP has expired
 *
 * @param {Date} otpExpiresAt - The expiry time of the OTP
 * @returns {boolean} True if the OTP has expired
 */
export const isOTPExpired = (otpExpiresAt) => {
	if (!otpExpiresAt) return true;
	return otpExpiresAt.getTime() < Date.now();
};

/**
 * Checks if the OTP cooldown is active
 *
 * @param {Date} otpExpiresAt - The expiry time of the OTP
 * @param {number} cooldownMs - The cooldown duration in milliseconds
 * @returns {boolean} True if the OTP cooldown is active
 */
export const isOTPCooldownActive = (otpExpiresAt, cooldownMs) => {
	if (!otpExpiresAt) return false;
	const otpCreatedAt = otpExpiresAt.getTime() - TEN_MINUTES_MS;
	return Date.now() - otpCreatedAt < cooldownMs;
};
