//* src/services/oauth.service.js

import mongoose from "mongoose";

import User from "../models/user.model.js";
import Session from "../models/session.model.js";
import Directory from "../models/directory.model.js";

import AppError from "../errors/AppError.js";

import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";

import sanitizeInput from "../utils/sanitizeInput.js";
import { enforceDeviceLimit } from "./session.service.js";

const { CONFLICT, UNAUTHORIZED, FORBIDDEN } = httpStatus;
const { PROVIDER_MISMATCH, UNAUTHORIZED_ACCESS, ACCOUNT_SUSPENDED } =
	appErrorCode;

/**
 * Shared OAuth sign-in flow: finds or creates the user, then issues a session.
 *
 * Provider-agnostic — callers must first exchange the provider's token/code and
 * produce a verified, normalized profile (including any email-verified checks)
 * before calling this function.
 *
 * @param {"google"|"github"} provider - OAuth provider the user signed in with.
 * @param {{ name: string, email: string, picture: string }} profile - Normalized profile from the provider.
 * @param {Object} deviceInfo - Parsed device metadata attached to the new session.
 * @returns {Promise<{ session: Object, isNewUser: boolean }>} The issued session and whether a new account was created.
 *
 * @throws {AppError} `PROVIDER_MISMATCH` — the email already belongs to an account registered with a different provider.
 */
export const loginOrCreateOAuthUser = async (provider, profile, deviceInfo) => {
	const { name: providerName, email, picture } = profile;

	// Sanitize the display name to prevent XSS and database overflow issues.
	const sanitizedName = sanitizeInput(providerName);

	// Use the sanitized name if available; otherwise, derive a name from the email prefix.
	// Provider names can be very long, so we truncate to fit within the User.name limit.
	const name = (sanitizedName || email.split("@")[0]).slice(0, 100);

	const existingUser = await User.findOne({ email }).lean();

	if (existingUser) {
		// Block email-match hijack: an account registered with a different
		// provider must not be accessible via this provider without an explicit link.
		if (existingUser.provider !== provider) {
			throw new AppError(
				`This email is registered with ${existingUser.provider}. Please sign in using that method.`,
				CONFLICT,
				PROVIDER_MISMATCH,
			);
		}

		// Reject locked-out accounts before issuing a session
		if (existingUser.deletedAt) {
			throw new AppError(
				"Account no longer exists",
				UNAUTHORIZED,
				UNAUTHORIZED_ACCESS,
			);
		}

		if (existingUser.suspendedAt) {
			throw new AppError("Account is suspended", FORBIDDEN, ACCOUNT_SUSPENDED);
		}

		/** Optional: update the user's name and profile picture on every sign-in, in case they changed it on the provider's side.
		if (existingUser.name !== name || existingUser.profilePicture !== picture) {
			await User.updateOne(
				{ _id: existingUser._id },
				{ name, profilePicture: picture },
				{ runValidators: true },
			);
		} */

		await enforceDeviceLimit(existingUser._id);

		const session = await Session.create({
			userId: existingUser._id,
			deviceInfo,
		});

		return { session, isNewUser: false };
	}

	const mongooseSession = await mongoose.startSession();
	const rootDirId = new mongoose.Types.ObjectId();
	const userId = new mongoose.Types.ObjectId();

	// Create the user and their root directory atomically
	try {
		await mongooseSession.withTransaction(async () => {
			await User.create(
				[
					{
						_id: userId,
						name,
						email,
						profilePicture: picture,
						provider,
						rootDirId,
						isVerified: true,
					},
				],
				{ session: mongooseSession },
			);

			await Directory.create(
				[
					{
						_id: rootDirId,
						name: `root-${email}`,
						userId,
						parentDirId: null,
					},
				],
				{ session: mongooseSession },
			);
		});
	} finally {
		await mongooseSession.endSession();
	}

	// Session.create stays OUTSIDE the transaction on purpose:
	// withTransaction can retry on write conflicts, and retrying session
	// creation would produce duplicate sessions for a single sign-in.
	const session = await Session.create({ userId, deviceInfo });

	return { session, isNewUser: true };
};
