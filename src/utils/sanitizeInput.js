//* src/utils/sanitizeInput.js

import { JSDOM } from "jsdom";
import DOMPurify from "dompurify";

const window = new JSDOM("").window;
const purify = DOMPurify(window);

// Removes all HTML tags from untrusted text before it is saved or shown.
// Extra protection against script-injection (XSS) attacks. Non-text input gives an empty string.
const sanitizeInput = (input) => {
	if (typeof input !== "string") return "";

	// Trim because stripping tags can leave edge whitespace ("<b> Al </b>" -> " Al ").
	return purify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).trim();
};

export default sanitizeInput;
