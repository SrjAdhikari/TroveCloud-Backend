//* src/templates/emails/passwordReset.js

import { layoutEmail } from "./_base.js";
import { codeBox, infoCallout, paragraph } from "./_components.js";

export const PASSWORD_RESET_EMAIL_TEMPLATE = (userName, otp) =>
	layoutEmail({
		preheader: `Your TroveCloud password reset code is ${otp}`,
		title: "Reset your password",
		bodyHtml: `
			<h1 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: inherit;">Reset your password</h1>
			${paragraph(`Hi ${userName},`)}
			${paragraph("We received a request to reset your TroveCloud password. Use the code below to choose a new one.")}
			${codeBox(otp)}
			${infoCallout("This code expires in 10 minutes. If you did not request a password reset, you can safely ignore this email — your password will remain unchanged.")}
		`,
	});
