//* src/constants/env.js

import { config } from "dotenv";

// Load variables from `.env` (default path).
// If you keep secrets elsewhere, pass { path: "..." }.
config();

// Function to access env variables
const getEnv = (key) => {
	const value = process.env[key];

	if (value === undefined) {
		throw new Error(`Environment variable ${key} is not defined`);
	}

	return value;
};

const getNumberEnv = (key) => {
	const value = Number(getEnv(key));

	if (!Number.isFinite(value)) {
		throw new Error(`Environment variable ${key} must be a number`);
	}

	return value;
};

const envConfig = Object.freeze({
	PORT: getEnv("PORT"),
	NODE_ENV: getEnv("NODE_ENV"),
	APP_ORIGIN: getEnv("APP_ORIGIN"),
	MONGODB_URI: getEnv("MONGODB_URI"),
	GOOGLE_CLIENT_ID: getEnv("GOOGLE_CLIENT_ID"),
	GITHUB_CLIENT_ID: getEnv("GITHUB_CLIENT_ID"),
	GITHUB_CLIENT_SECRET: getEnv("GITHUB_CLIENT_SECRET"),
	COOKIE_SECRET: getEnv("COOKIE_SECRET"),
	RESEND_API_KEY: getEnv("RESEND_API_KEY"),
	EMAIL_FROM: getEnv("EMAIL_FROM"),
	R2_ACCOUNT_ID: getEnv("R2_ACCOUNT_ID"),
	R2_ACCESS_KEY_ID: getEnv("R2_ACCESS_KEY_ID"),
	R2_SECRET_ACCESS_KEY: getEnv("R2_SECRET_ACCESS_KEY"),
	R2_BUCKET: getEnv("R2_BUCKET"),
	
	MAX_ALLOWED_DEVICES: getNumberEnv("MAX_ALLOWED_DEVICES"),
	MAX_FILE_UPLOAD_SIZE: getNumberEnv("MAX_FILE_UPLOAD_SIZE"),
	MAX_DRIVE_IMPORT_SIZE: getNumberEnv("MAX_DRIVE_IMPORT_SIZE"),
	MAX_PROFILE_PICTURE_SIZE: getNumberEnv("MAX_PROFILE_PICTURE_SIZE"),
	DEFAULT_STORAGE_LIMIT: getNumberEnv("DEFAULT_STORAGE_LIMIT"),
});

export default envConfig;
