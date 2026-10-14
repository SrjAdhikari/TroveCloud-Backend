//* src/templates/emails/verifyEmail.js

import { layoutEmail } from "./_base.js";
import { codeBox, infoCallout, paragraph } from "./_components.js";

/**
 * Email verification OTP email sent during registration (and re-registration of unverified accounts).
 *
 * @param {string} userName - Recipient's display name
 * @param {string} otp - 6-digit verification code (plain text, not hashed)
 * @returns {string} Complete HTML email body
 */
export const VERIFY_EMAIL_TEMPLATE = (userName, otp) =>
	layoutEmail({
		preheader: `Your TroveCloud verification code is ${otp}`,
		title: "Verify your email address",
		bodyHtml: `
			<h1 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: inherit;">Verify your email address</h1>
			${paragraph(`Hi ${userName},`)}
			${paragraph("Please use the 6-digit code below to verify your email address and continue to TroveCloud.")}
			${codeBox(otp)}
			${infoCallout("This code expires in 10 minutes. If you did not create a TroveCloud account, you can safely ignore this email.")}
		`,
	});
