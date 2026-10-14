//* src/lib/githubAuth.js

import envConfig from "../constants/env.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";

import AppError from "../errors/AppError.js";

const { BAD_REQUEST } = httpStatus;
const { INVALID_GITHUB_CODE, GITHUB_EMAIL_NOT_VERIFIED } = appErrorCode;
const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, NODE_ENV } = envConfig;

// GitHub API constants
const GITHUB_FETCH_TIMEOUT_MS = 8000;
const GITHUB_USER_AGENT = "TroveCloud";

// Swaps the one-time GitHub login code for the user's name, email and picture.
// Fails if the account has no verified main email.
const verifyGithubCodeAndFetchProfile = async (code) => {
	try {
		// 1. Exchange the authorization code for an access token
		const response = await fetch(
			"https://github.com/login/oauth/access_token",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"User-Agent": GITHUB_USER_AGENT,
				},
				body: JSON.stringify({
					client_id: GITHUB_CLIENT_ID,
					client_secret: GITHUB_CLIENT_SECRET,
					code,
				}),
				signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
			},
		);

		if (!response.ok) {
			throw new AppError(
				"GitHub rejected the authorization code",
				BAD_REQUEST,
				INVALID_GITHUB_CODE,
			);
		}

		const data = await response.json();

		if (data.error || !data.access_token) {
			throw new AppError(
				"Invalid GitHub code",
				BAD_REQUEST,
				INVALID_GITHUB_CODE,
			);
		}

		const accessToken = data.access_token;

		// 2. Fetch the user's profile using the access token
		const userResponse = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github+json",
				"User-Agent": GITHUB_USER_AGENT,
			},
			signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
		});

		if (!userResponse.ok) {
			throw new AppError(
				"Failed to fetch GitHub profile",
				BAD_REQUEST,
				INVALID_GITHUB_CODE,
			);
		}

		const userData = await userResponse.json();

		// 3. Fetch the user's emails.
		// `userData.email` is null when the user keeps their address private,
		// so `/user/emails` is the authoritative source for the verified primary address.
		const emailResponse = await fetch("https://api.github.com/user/emails", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github+json",
				"User-Agent": GITHUB_USER_AGENT,
			},
			signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
		});

		if (!emailResponse.ok) {
			throw new AppError(
				"Failed to fetch GitHub emails",
				BAD_REQUEST,
				INVALID_GITHUB_CODE,
			);
		}

		const emailData = await emailResponse.json();

		const primaryEmail = emailData.find(
			(email) => email.primary && email.verified,
		);

		if (!primaryEmail) {
			throw new AppError(
				"No verified primary email on this GitHub account",
				BAD_REQUEST,
				GITHUB_EMAIL_NOT_VERIFIED,
			);
		}

		return {
			name: userData.name || userData.login,
			email: primaryEmail.email,
			picture: userData.avatar_url,
		};
	} catch (error) {
		// Re-throw known AppErrors as-is; only wrap unexpected failures
		// (network errors, malformed JSON, etc.) as INVALID_GITHUB_CODE.
		if (error instanceof AppError) throw error;

		if (NODE_ENV !== "production") {
			console.error("[verifyGithubCode] underlying error:", error);
		}
		throw new AppError("Invalid GitHub code", BAD_REQUEST, INVALID_GITHUB_CODE);
	}
};

export default verifyGithubCodeAndFetchProfile;
