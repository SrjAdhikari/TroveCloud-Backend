//* src/utils/deviceInfo.js

import { UAParser } from "ua-parser-js";

// Builds the device details (browser, system, IP address) saved with each session.
const buildDeviceInfo = (req) => {
	const userAgent = req.headers["user-agent"] || "";
	const ipAddress =
		req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "Unknown";

	const parser = new UAParser(userAgent);
	const parsedUA = parser.getResult();

	return {
		userAgent,
		ipAddress,
		deviceType: parsedUA.device.type || "desktop",
		browser:
			`${parsedUA.browser.name || "Unknown"} ${parsedUA.browser.version || ""}`.trim(),
		deviceOS:
			`${parsedUA.os.name || "Unknown"} ${parsedUA.os.version || ""}`.trim(),
	};
};

export default buildDeviceInfo;
