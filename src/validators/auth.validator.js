//* src/validators/auth.validator.js

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

const email = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.email("Please enter a valid email address"));

const password = z
	.string()
	.trim()
	.min(8, "Password must be at least 8 characters")
	.regex(/[a-z]/, "Password must contain at least one lowercase letter")
	.regex(/[A-Z]/, "Password must contain at least one uppercase letter")
	.regex(/[0-9]/, "Password must contain at least one number")
	.regex(
		/[^A-Za-z0-9]/,
		"Password must contain at least one special character",
	);

const otp = z
	.string()
	.trim()
	.regex(/^\d{6}$/, "OTP must be a 6-digit code");

export const registerSchema = z.object({
	name,
	email,
	password,
});

export const loginSchema = z.object({
	email,
	password: z.string().trim().nonempty("Password is required"),
});

export const verifyOtpSchema = z.object({
	email,
	otp,
});

export const resendOtpSchema = z.object({
	email,
});

export const forgotPasswordSchema = z.object({
	email,
});

export const resetPasswordSchema = z.object({
	email,
	otp,
	newPassword: password,
});

export const changePasswordSchema = z.object({
	currentPassword: z.string().trim().nonempty("Current password is required"),
	newPassword: password,
});

export const googleOAuthSchema = z.object({
	idToken: z.string().trim().nonempty("ID token is required"),
});

export const githubOAuthSchema = z.object({
	code: z.string().trim().nonempty("Authorization code is required"),
});
