//* src/services/otp.service.js

import crypto from "crypto";
import sendEmail from "../lib/sendEmail.js";
import {
	VERIFY_EMAIL_TEMPLATE,
	PASSWORD_RESET_EMAIL_TEMPLATE,
} from "../templates/emails/index.js";
import { TEN_MINUTES_MS, tenMinutesFromNow } from "../utils/date.js";

export const generateOTP = () => {
	const plainOTP = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
	const hashedOTP = crypto.createHash("sha256").update(plainOTP).digest("hex");

	return { plainOTP, hashedOTP };
};

// Checks the code the user typed against the saved one.
// The check always takes the same time, so an attacker can't guess the code by timing it.
export const isValidOTP = (inputOTP, storedHash) => {
	const inputHash = crypto
		.createHash("sha256")
		.update(String(inputOTP))
		.digest();
	const stored = Buffer.from(storedHash, "hex");

	if (inputHash.length !== stored.length) return false;
	return crypto.timingSafeEqual(inputHash, stored);
};

export const sendOTP = async (name, email, otp) => {
	await sendEmail(
		email,
		"Verify your email address",
		VERIFY_EMAIL_TEMPLATE(name, otp),
	);
};

export const sendPasswordResetOTP = async (name, email, otp) => {
	await sendEmail(
		email,
		"Reset your password",
		PASSWORD_RESET_EMAIL_TEMPLATE(name, otp),
	);
};

export const issueOTPToUser = async (user) => {
	const { plainOTP, hashedOTP } = generateOTP();

	user.otp = hashedOTP;
	user.otpExpiresAt = tenMinutesFromNow();
	await user.save();

	return plainOTP;
};

export const isOTPExpired = (otpExpiresAt) => {
	if (!otpExpiresAt) return true;
	return otpExpiresAt.getTime() < Date.now();
};

export const isOTPCooldownActive = (otpExpiresAt, cooldownMs) => {
	if (!otpExpiresAt) return false;
	const otpCreatedAt = otpExpiresAt.getTime() - TEN_MINUTES_MS;
	return Date.now() - otpCreatedAt < cooldownMs;
};
