//* src/utils/contentDisposition.js

const FALLBACK_NAME = "download";

// Quotes and backslashes terminate the quoted-string; CR/LF would let a crafted
// filename split the header and inject one of its own.
const toAsciiFallback = (name) => {
	const ascii = name
		.replace(/[\r\n]/g, "")
		.replace(/["\\]/g, "")
		.replace(/[^\x20-\x7e]/g, "")
		.trim();

	return ascii || FALLBACK_NAME;
};

// encodeURIComponent leaves ' ( ) * ! alone, none of which are RFC 5987
// attr-char. Escaping them keeps strict parsers from mis-splitting the value.
const toExtendedValue = (name) =>
	encodeURIComponent(name).replace(
		/['()*!]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

// Builds the download header so filenames with non-English characters still work.
// With no filename, it returns just the type.
const buildContentDisposition = (type, fileName) => {
	if (fileName === undefined) return type;

	const safeName = typeof fileName === "string" ? fileName : "";
	const asciiName = toAsciiFallback(safeName);
	const extendedName = toExtendedValue(safeName || FALLBACK_NAME);
	const disposition = `${type}; filename="${asciiName}"; filename*=UTF-8''${extendedName}`;

	return disposition;
};

export default buildContentDisposition;
