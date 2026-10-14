//* src/utils/fileCategories.js

// Groups file extensions into storage categories, with the icon the frontend shows
// for each. Used for the storage breakdown.

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

export const categorizeExtension = (extension) => {
	const normalized = (extension ?? "").replace(/^\./, "").toLowerCase();
	return EXTENSION_CATEGORY[normalized] ?? "Other";
};
