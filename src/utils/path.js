//* src/utils/path.js

// Builds the trail of folders from the top one down to the current one.
// Each item has an _id and a name, e.g. My Files, Documents, Reports.
export const generateBreadCrumb = (ancestors = [], current) =>
	current
		? [...ancestors, { _id: current._id, name: current.name }]
		: [...ancestors];

// Joins folder names into a path, e.g. "/My Files/Documents/Reports".
export const generatePath = (breadcrumb = []) =>
	`/${breadcrumb.map(({ name }) => name).join("/")}`;
