//* src/services/session.service.js

import Session from "../models/session.model.js";
import envConfig from "../constants/env.js";

const { MAX_ALLOWED_DEVICES } = envConfig;

// If the user is already signed in on the maximum number of devices, signs out the oldest one.
// Call this right before creating a new login session.
export const enforceDeviceLimit = async (userId) => {
	const activeSessionCount = await Session.countDocuments({ userId });

	// Evict the oldest session first (FIFO) so the user's most recently
	// used devices stay signed in.
	if (activeSessionCount >= MAX_ALLOWED_DEVICES) {
		await Session.findOneAndDelete({ userId }, { sort: { createdAt: 1 } });
	}
};
