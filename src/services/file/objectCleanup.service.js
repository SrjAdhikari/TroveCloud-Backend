//* src/services/file/objectCleanup.service.js

import {
	deleteObjects,
	FILE_KEY_PATTERN,
	MAX_DELETE_KEYS_PER_REQUEST,
	PROFILE_PICTURE_KEY_PATTERN,
} from "../../lib/r2.js";

const isValidKey = (key) =>
	typeof key === "string" &&
	(FILE_KEY_PATTERN.test(key) || PROFILE_PICTURE_KEY_PATTERN.test(key));

/**
 * Removes objects from the storage based on the provided items.
 * Each item should have a 'key' and a 'label'.
 * Invalid keys will be skipped, and any errors during deletion will be logged.
 *
 * @param {{ key: string, label: string }[]} items
 */
const removeObjects = async (items) => {
	const labelByKey = new Map();

	for (const { key, label } of items) {
		if (isValidKey(key)) {
			labelByKey.set(key, label);
		} else {
			console.warn(`Skipped removing the object for ${label}: invalid key`);
		}
	}

	if (labelByKey.size === 0) return;

	const keys = [...labelByKey.keys()];

	for (let i = 0; i < keys.length; i += MAX_DELETE_KEYS_PER_REQUEST) {
		const chunk = keys.slice(i, i + MAX_DELETE_KEYS_PER_REQUEST);

		try {
			const { errors } = await deleteObjects(chunk);

			for (const { key, code } of errors) {
				console.warn(
					`Failed to remove the object for ${labelByKey.get(key)}: ${code}`,
				);
			}
		} catch (error) {
			console.warn(
				`Failed to remove ${chunk.length} objects: ${error.name} ${error.$metadata?.httpStatusCode ?? ""}`.trim(),
			);
		}
	}
};

export { removeObjects };
