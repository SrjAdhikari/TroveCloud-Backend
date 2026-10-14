//* src/templates/emails/_components.js

import { brand } from "./_base.js";

/**
 * Body paragraph — consistent size, line-height, spacing.
 *
 * @param {string} text
 * @returns {string} HTML fragment
 */
export const paragraph = (text) =>
	`<p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: ${brand.textColor};">${text}</p>`;

/**
 * Secondary / muted paragraph — for explanatory text below the main point.
 *
 * @param {string} text
 * @returns {string} HTML fragment
 */
export const mutedParagraph = (text) =>
	`<p style="margin: 16px 0 0; font-size: 13px; line-height: 1.6; color: ${brand.mutedColor};">${text}</p>`;

/**
 * Boxed display for 6-digit OTPs. Monospace, spaced-out, centered —
 * scannable at a glance and easy to copy character-by-character.
 *
 * @param {string} code
 * @returns {string} HTML fragment
 */
export const codeBox = (code) => `
<div style="text-align: center; margin: 28px 0;">
	<div style="display: inline-block; padding: 16px 24px; background-color: ${brand.bgColor}; border: 1px solid ${brand.borderColor}; border-radius: 6px;">
		<span style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 28px; font-weight: 600; letter-spacing: 8px; color: ${brand.primaryColor};">${code}</span>
	</div>
</div>`;

/**
 * Amber callout for security-relevant information — draws the eye without alarming the reader.
 * Use for expiration notes, "if this wasn't you" guidance, etc.
 *
 * @param {string} message
 * @returns {string} HTML fragment
 */
export const infoCallout = (message) => `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 24px 0; background-color: ${brand.alertBg}; border-left: 3px solid ${brand.alertBorder}; border-radius: 4px;">
	<tr>
		<td style="padding: 12px 16px; font-size: 14px; line-height: 1.6; color: ${brand.alertText};">${message}</td>
	</tr>
</table>`;

/**
 * Two-column key/value list for displaying metadata — e.g., device info on the new-device alert.
 *
 * @param {Array<{ label: string, value: string }>} items
 * @returns {string} HTML fragment
 */
export const definitionList = (items) => {
	const rows = items
		.map(
			({ label, value }) => `
		<tr>
			<td style="padding: 8px 12px 8px 0; font-size: 13px; color: ${brand.mutedColor}; width: 140px; vertical-align: top;">${label}</td>
			<td style="padding: 8px 0; font-size: 14px; color: ${brand.textColor}; vertical-align: top;">${value}</td>
		</tr>`,
		)
		.join("");

	return `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 20px 0; border-top: 1px solid ${brand.borderColor}; border-bottom: 1px solid ${brand.borderColor};">
	${rows}
</table>`;
};
