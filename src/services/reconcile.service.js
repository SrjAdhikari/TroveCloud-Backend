//* src/services/reconcile.service.js

import File from "../models/file.model.js";
import User from "../models/user.model.js";

import {
	listObjects,
	deleteObjects,
	FILE_PREFIX,
	PROFILE_PICTURE_PREFIX,
	FILE_KEY_PATTERN,
	PROFILE_PICTURE_KEY_PATTERN,
} from "../lib/r2.js";
import { MAX_UPLOAD_RESERVATION_MS } from "./file.service.js";

import httpStatus from "../constants/httpStatus.js";
import appErrorCode from "../constants/appErrorCode.js";
import AppError from "../errors/AppError.js";

const { CONFLICT } = httpStatus;
const { ORPHAN_RATIO_EXCEEDED } = appErrorCode;

const DEFAULT_MAX_ORPHAN_RATIO = 0.2;

// The `ownedKeys` functions are per prefix because the ownership check is per collection.
// A key that looks like a file but is actually a profile picture is not owned by any File row, and vice versa.
const ownedFileKeys = async (keys) => {
	const rows = await File.find({ objectKey: { $in: keys } })
		.select("objectKey")
		.lean();

	return new Set(rows.map((row) => row.objectKey));
};

const ownedProfilePictureKeys = async (keys) => {
	const rows = await User.find({ profilePictureKey: { $in: keys } })
		.select("profilePictureKey")
		.lean();

	return new Set(rows.map((row) => row.profilePictureKey));
};

// The pattern is per prefix because it also decides which collection owns the key.
const SCAN_TARGETS = [
	{
		prefix: FILE_PREFIX,
		pattern: FILE_KEY_PATTERN,
		ownedKeys: ownedFileKeys,
	},
	{
		prefix: PROFILE_PICTURE_PREFIX,
		pattern: PROFILE_PICTURE_KEY_PATTERN,
		ownedKeys: ownedProfilePictureKeys,
	},
];

// Exported so a caller reporting what was covered cannot hold a stale copy.
const SCANNED_PREFIXES = SCAN_TARGETS.map((target) => target.prefix);

const scanForOrphans = async () => {
	// The floor is the oldest lastModified an object can have to be considered for deletion.
	const floorMs = Date.now() - MAX_UPLOAD_RESERVATION_MS;

	const report = {
		scanned: 0,
		unrecognized: 0,
		skippedTooNew: 0,
		checked: 0,
		owned: 0,
		candidates: [],
	};

	for (const { prefix, pattern, ownedKeys } of SCAN_TARGETS) {
		let continuationToken;

		// The listing is paginated, so we loop until the last page.
		do {
			// The trailing slash matters: S3 matches prefixes as plain strings, so
			// "files" would also list a sibling like "files-archive/".
			const page = await listObjects(`${prefix}/`, continuationToken);
			report.scanned += page.keys.length;

			const recognized = page.keys.filter((object) => pattern.test(object.key));

			// Anything but a real Date has an unknown age: null, 0, and "" all
			// compare below the floor, so the type check is what fails them safe.
			const aged = recognized.filter(
				(object) =>
					object.lastModified instanceof Date &&
					object.lastModified.getTime() < floorMs,
			);

			report.unrecognized += page.keys.length - recognized.length;
			report.skippedTooNew += recognized.length - aged.length;
			report.checked += aged.length;

			// A page with nothing aged would otherwise issue an empty `$in`.
			if (aged.length) {
				const owned = await ownedKeys(aged.map((object) => object.key));

				for (const object of aged) {
					if (owned.has(object.key)) {
						report.owned += 1;
						continue;
					}

					report.candidates.push({
						key: object.key,
						size: object.size,
						lastModified: object.lastModified,
					});
				}
			}

			continuationToken = page.nextToken;
		} while (continuationToken);
	}

	return report;
};

const reclaimOrphans = async (
	candidates,
	{ scanned, maxRatio = DEFAULT_MAX_ORPHAN_RATIO } = {},
) => {
	// The ratio only guards anything if the denominator is real: a negative,
	// fractional, or stringy `scanned` divides into a ratio under any threshold,
	// and one below the candidate count means the two came from different runs.
	if (
		!Number.isInteger(scanned) ||
		scanned < 0 ||
		scanned < candidates.length
	) {
		throw new AppError(
			`Refusing to delete: ${scanned} is not a usable count of scanned objects for ${candidates.length} candidates`,
			CONFLICT,
			ORPHAN_RATIO_EXCEEDED,
		);
	}

	const ratio = candidates.length === 0 ? 0 : candidates.length / scanned;

	// Safety check: if the ratio of orphaned objects exceeds the limit, throw an error and do not delete anything.
	if (!(ratio <= maxRatio)) {
		throw new AppError(
			`${candidates.length} of ${scanned} scanned objects look orphaned, above the ${maxRatio} safety limit; nothing was deleted`,
			CONFLICT,
			ORPHAN_RATIO_EXCEEDED,
		);
	}

	// Delete the orphaned objects from R2.
	const { deleted, errors } = await deleteObjects(
		candidates.map((candidate) => candidate.key),
	);

	return { ratio, deleted, errors };
};

export {
	DEFAULT_MAX_ORPHAN_RATIO,
	SCANNED_PREFIXES,
	scanForOrphans,
	reclaimOrphans,
};
