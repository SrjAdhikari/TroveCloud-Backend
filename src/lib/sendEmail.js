//* src/lib/sendEmail.js

import { Resend } from "resend";
import envConfig from "../constants/env.js";
import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import AppError from "../errors/AppError.js";

const { RESEND_API_KEY, EMAIL_FROM } = envConfig;
const { INTERNAL_SERVER_ERROR } = httpStatus;
const { EMAIL_SEND_FAILED } = appErrorCode;

const resend = new Resend(RESEND_API_KEY);

// Sends an HTML email through Resend.
// If sending fails, it logs the problem and throws a normal app error, so an email outage cannot crash the server.
const sendEmail = async (to, subject, html) => {
	try {
		const { error } = await resend.emails.send({
			from: EMAIL_FROM,
			to,
			subject,
			html,
		});

		// This catches API-level rejections (e.g., invalid email formats or domain bans)
		if (error) {
			console.error("Resend API Domain Error:", error);
			throw new AppError(
				"Failed to send email",
				INTERNAL_SERVER_ERROR,
				EMAIL_SEND_FAILED,
			);
		}
	} catch (err) {
		if (err instanceof AppError) throw err;

		// Network-level failures (DNS timeouts, Resend outages) that bypass the API response
		console.error("Critical Network Error dispatching email:", err);
		throw new AppError(
			"Internal gateway error. Could not dispatch email.",
			INTERNAL_SERVER_ERROR,
			EMAIL_SEND_FAILED,
		);
	}
};

export default sendEmail;
