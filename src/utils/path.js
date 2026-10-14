//* src/utils/path.js

/**
 * Builds the clickable breadcrumb trail (root → current, self-inclusive)
 * E.g. [{_id: "idRoot", name: "My Files"}, {_id: "idParent", name: "Documents"}, {_id: "idCurrent", name: "Reports"}]
 *
 * @param {Array<{_id, name}>} ancestors - resolved ancestor chain (root → parent)
 * @param {{_id, name}} [current] - the current directory, appended as the last crumb
 * @returns {Array<{_id, name}>}
 */
export const generateBreadCrumb = (ancestors = [], current) =>
	current
		? [...ancestors, { _id: current._id, name: current.name }]
		: [...ancestors];

/**
 * Builds a display path string from a breadcrumb
 * E.g. "/My Files/Documents/Reports"
 *
 * @param {Array<{name}>} breadcrumb - A self-inclusive breadcrumb (root → current)
 * @returns {string}
 */
export const generatePath = (breadcrumb = []) =>
	`/${breadcrumb.map(({ name }) => name).join("/")}`;
