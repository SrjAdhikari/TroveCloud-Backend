//* src/services/session.service.js

import Session from "../models/session.model.js";
import envConfig from "../constants/env.js";

const { MAX_ALLOWED_DEVICES } = envConfig;

/**
 * Caps the number of concurrent sessions a user can have.
 *
 * If the user is already at or over `MAX_ALLOWED_DEVICES`, the oldest session
 * is evicted to make room for a new one. Call this immediately before
 * `Session.create()` in any sign-in flow.
 *
 * @param {import("mongoose").Types.ObjectId | string} userId - User whose sessions should be capped.
 * @returns {Promise<void>}
 */
export const enforceDeviceLimit = async (userId) => {
	const activeSessionCount = await Session.countDocuments({ userId });

	// Evict the oldest session first (FIFO) so the user's most recently
	// used devices stay signed in.
	if (activeSessionCount >= MAX_ALLOWED_DEVICES) {
		await Session.findOneAndDelete({ userId }, { sort: { createdAt: 1 } });
	}
};
