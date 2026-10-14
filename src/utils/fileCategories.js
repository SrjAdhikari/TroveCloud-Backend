//* src/utils/fileCategories.js

/**
 * Maps a file extension to a coarse storage category and exposes the Lucide
 * icon each category renders with on the frontend. Used by the storage-usage
 * breakdown. Extensions are matched lowercase, with or without a leading dot.
 */

export const CATEGORY_ICONS = Object.freeze({
	Documents: "file-text",
	Images: "image",
	Videos: "video",
	Audio: "music",
	Archives: "archive",
	Other: "file",
});

// Extension (no dot, lowercase) → category. Anything unlisted is "Other".
const EXTENSION_CATEGORY = Object.freeze({
	// Documents
	pdf: "Documents",
	doc: "Documents",
	docx: "Documents",
	txt: "Documents",
	md: "Documents",
	rtf: "Documents",
	odt: "Documents",
	xls: "Documents",
	xlsx: "Documents",
	csv: "Documents",
	ppt: "Documents",
	pptx: "Documents",
	odp: "Documents",
	ods: "Documents",
	// Images
	jpg: "Images",
	jpeg: "Images",
	png: "Images",
	gif: "Images",
	webp: "Images",
	svg: "Images",
	bmp: "Images",
	tiff: "Images",
	ico: "Images",
	heic: "Images",
	// Videos
	mp4: "Videos",
	mov: "Videos",
	avi: "Videos",
	mkv: "Videos",
	webm: "Videos",
	flv: "Videos",
	wmv: "Videos",
	m4v: "Videos",
	// Audio
	mp3: "Audio",
	wav: "Audio",
	flac: "Audio",
	aac: "Audio",
	ogg: "Audio",
	m4a: "Audio",
	wma: "Audio",
	// Archives
	zip: "Archives",
	rar: "Archives",
	"7z": "Archives",
	tar: "Archives",
	gz: "Archives",
	bz2: "Archives",
	xz: "Archives",
});

/**
 * Resolves a file extension to its storage category.
 *
 * @param {string} [extension] - Extension as stored on the file (e.g. ".jpg"),
 *   case-insensitive; a missing leading dot or empty/undefined value is tolerated.
 * @returns {string} One of the keys in `CATEGORY_ICONS`; "Other" when unknown.
 */
export const categorizeExtension = (extension) => {
	const normalized = (extension ?? "").replace(/^\./, "").toLowerCase();
	return EXTENSION_CATEGORY[normalized] ?? "Other";
};
