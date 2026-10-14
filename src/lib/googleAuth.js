//* src/lib/googleAuth.js

import { OAuth2Client } from "google-auth-library";

import envConfig from "../constants/env.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";

import AppError from "../errors/AppError.js";

const { BAD_REQUEST } = httpStatus;
const { INVALID_ID_TOKEN } = appErrorCode;

const { GOOGLE_CLIENT_ID, NODE_ENV } = envConfig;
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

const verifyGoogleIdToken = async (idToken) => {
	try {
		const ticket = await client.verifyIdToken({
			idToken,
			audience: GOOGLE_CLIENT_ID,
		});

		const payload = ticket.getPayload();
		return payload;
	} catch (error) {
		if (NODE_ENV !== "production") {
			console.error("[verifyGoogleIdToken] underlying error:", error);
		}
		throw new AppError("Invalid ID token", BAD_REQUEST, INVALID_ID_TOKEN);
	}
};

export default verifyGoogleIdToken;
