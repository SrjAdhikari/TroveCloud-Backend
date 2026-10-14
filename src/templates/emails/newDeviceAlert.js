//* src/templates/emails/newDeviceAlert.js

import { layoutEmail } from "./_base.js";
import {
	definitionList,
	infoCallout,
	mutedParagraph,
	paragraph,
} from "./_components.js";
import sanitizeInput from "../../utils/sanitizeInput.js";

/**
 * Security alert sent when a new device / browser signs into the TroveCloud account.
 * This helps users spot unauthorized access.
 *
 * @param {string} userName - Recipient's display name
 * @param {Object} params
 * @param {{ browser: string, deviceOS: string, deviceType: string, ipAddress: string }} params.deviceInfo
 *   Parsed device metadata from the new session (same shape as the
 *   Session model stores)
 * @param {Date} params.signedInAt - When the session was created
 * @returns {string} Complete HTML email body
 */
export const NEW_DEVICE_ALERT_EMAIL_TEMPLATE = (
	userName,
	{ deviceInfo, signedInAt },
) => {
	const formatted =
		signedInAt.toLocaleString("en-US", {
			dateStyle: "medium",
			timeStyle: "short",
			timeZone: "UTC",
		}) + " UTC";

	return layoutEmail({
		preheader: "A new device just signed in to your TroveCloud account.",
		title: "New sign-in to your account",
		bodyHtml: `
			<h1 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: inherit;">New sign-in detected</h1>
			${paragraph(`Hi ${userName},`)}
			${paragraph("A new device just signed in to your TroveCloud account. If this was you, no action is needed.")}
			${definitionList([
				{ label: "When", value: formatted },
				{
					label: "Device",
					value: `${sanitizeInput(deviceInfo.browser)} on ${sanitizeInput(deviceInfo.deviceOS)}`,
				},
				{ label: "Device type", value: sanitizeInput(deviceInfo.deviceType) },
				{ label: "IP address", value: sanitizeInput(deviceInfo.ipAddress) },
			])}
			${infoCallout("If you do not recognize this sign-in, sign out of all devices from your account settings and change your password immediately. If you signed in via Google or GitHub, revoke the session from your identity provider's security settings as well.")}
			${mutedParagraph("This alert is sent the first time a new device or browser signs in to your account.")}
		`,
	});
};
