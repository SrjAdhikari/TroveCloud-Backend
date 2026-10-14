//* src/templates/emails/_base.js

// Colors and logo shared by all TroveCloud emails.
// The amber alert colors are only for security notices.
export const brand = Object.freeze({
	name: "TroveCloud",
	primaryColor: "#7C3AED",
	logoUrl: "https://assets.trovecloud.app/email/logo.png",
	textColor: "#111827",
	mutedColor: "#6b7280",
	bgColor: "#f9fafb",
	cardBg: "#ffffff",
	borderColor: "#e5e7eb",
	alertBg: "#fff7ed",
	alertBorder: "#f59e0b",
	alertText: "#7c2d12",
});

// Wraps an email body in the shared layout: header, content box and footer.
// Uses tables and inline styles so it displays correctly in Gmail, Outlook and Apple Mail.
export const layoutEmail = ({
	preheader = "",
	title = "",
	bodyHtml = "",
}) => `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${brand.bgColor}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: ${brand.textColor}; -webkit-font-smoothing: antialiased;">
	<!-- Preheader: rendered in inbox preview, hidden inside the message -->
	<span style="display: none; font-size: 1px; color: ${brand.bgColor}; line-height: 1px; max-height: 0; max-width: 0; opacity: 0; overflow: hidden;">${preheader}</span>

	<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: ${brand.bgColor}; padding: 32px 16px;">
		<tr>
			<td align="center">
				<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; background-color: ${brand.cardBg}; border: 1px solid ${brand.borderColor}; border-radius: 8px; overflow: hidden;">
					<!-- Brand header: logo on top, wordmark below, both centered -->
					<tr>
						<td align="center" style="padding: 28px 32px 20px; border-bottom: 1px solid ${brand.borderColor};">
							<img src="${brand.logoUrl}" alt="${brand.name}" width="52" height="52" style="display: block; margin: 0 auto 1px; border: 0;" />
							<div style="font-size: 24px; font-weight: 700; color: ${brand.primaryColor}; letter-spacing: 0.2px;">${brand.name}</div>
						</td>
					</tr>

					<!-- Body -->
					<tr>
						<td style="padding: 32px;">
							${bodyHtml}
						</td>
					</tr>

					<!-- Footer -->
					<tr>
						<td align="center" style="padding: 16px 32px; background-color: ${brand.bgColor}; border-top: 1px solid ${brand.borderColor}; font-size: 12px; color: ${brand.mutedColor}; line-height: 1.6;">
							This is an automated message from ${brand.name}. Please do not reply to this email.
							<br />
							&copy; ${new Date().getFullYear()} ${brand.name}. All rights reserved.
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
</body>
</html>`;
