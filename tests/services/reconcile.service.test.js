import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";

// Workers share one real dev bucket, so a real scan would read another worker's
// live objects as orphans. Only the two bucket-wide calls are faked; the rest of
// the module stays real — the key patterns and the TTL reservation.service derives its
// reservation ceiling from must be the shipped ones.
vi.mock("../../src/lib/r2.js", async (importOriginal) => ({
	...(await importOriginal()),
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
}));

import {
	listObjects,
	deleteObjects,
	FILE_PREFIX,
	PROFILE_PICTURE_PREFIX,
} from "../../src/lib/r2.js";
import {
	DEFAULT_MAX_ORPHAN_RATIO,
	SCANNED_PREFIXES,
	scanForOrphans,
	reclaimOrphans,
} from "../../src/services/reconcile.service.js";
import {
	MAX_UPLOAD_RESERVATION_MS,
} from "../../src/services/file/reservation.service.js";
import { ONE_MINUTE_MS } from "../../src/utils/date.js";

import File from "../../src/models/file.model.js";
import User from "../../src/models/user.model.js";
import {
	createTestUser,
	createTestDirectory,
	createTestFile,
} from "../factories.js";

let now;

const objectId = () => new mongoose.Types.ObjectId().toString();
const nonce = () => randomBytes(16).toString("hex");

const fileKey = (id = objectId()) => `files/${id}-${nonce()}.pdf`;
const pictureKey = (ownerId = objectId()) =>
	`profile-pictures/${ownerId}-${nonce()}`;

// Ages are expressed against the frozen clock so the floor comparison is exact.
const aged = (key, { olderBy = ONE_MINUTE_MS, size = 100 } = {}) => ({
	key,
	size,
	lastModified: new Date(now - MAX_UPLOAD_RESERVATION_MS - olderBy),
});

const fresh = (key, { size = 100 } = {}) => ({
	key,
	size,
	lastModified: new Date(now - ONE_MINUTE_MS),
});

const stockBucket = (objects, { pageSize = Infinity } = {}) => {
	listObjects.mockImplementation(async (prefix, continuationToken) => {
		const matching = objects.filter((object) => object.key.startsWith(prefix));
		const start = continuationToken ? Number(continuationToken) : 0;
		const next = start + pageSize;

		return {
			keys: matching.slice(start, next),
			nextToken: next < matching.length ? String(next) : undefined,
		};
	});
};

beforeEach(() => {
	// restoreAllMocks leaves a vi.fn's call history intact, so the
	// `not.toHaveBeenCalled` assertions below would otherwise depend on test order.
	vi.clearAllMocks();

	now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now);

	stockBucket([]);
	deleteObjects.mockImplementation(async (keys) => ({
		deleted: [...keys],
		errors: [],
	}));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("scanForOrphans", () => {
	it("reports an aged object that no row claims as a candidate", async () => {
		const key = fileKey();
		stockBucket([aged(key, { size: 4096 })]);

		const report = await scanForOrphans();

		expect(report.scanned).toBe(1);
		expect(report.checked).toBe(1);
		expect(report.owned).toBe(0);
		expect(report.candidates).toEqual([
			{ key, size: 4096, lastModified: expect.any(Date) },
		]);
	});

	it("queries profile-picture owners through the partial index filter", async () => {
		const findSpy = vi.spyOn(User, "find");
		const key = pictureKey();
		stockBucket([aged(key)]);

		await scanForOrphans();

		expect(findSpy).toHaveBeenCalledWith({
			profilePictureKey: { $in: [key], $type: "string" },
		});
	});

	// `File.objectKey` is `select: false`; a broken projection makes every file
	// in the bucket look orphaned.
	it("treats an object claimed by a ready row as owned", async () => {
		const user = await createTestUser();
		const directory = await createTestDirectory(user._id);
		const file = await createTestFile(user._id, directory._id, {
			objectKey: fileKey(),
		});
		stockBucket([aged(file.objectKey)]);

		const report = await scanForOrphans();

		expect(report.owned).toBe(1);
		expect(report.candidates).toEqual([]);
	});

	// D5: a pending row legitimately owns its object before confirm, so a
	// `status` filter on the diff would delete live reservations.
	it("treats an object claimed by a pending row as owned", async () => {
		const user = await createTestUser();
		const directory = await createTestDirectory(user._id);
		const file = await createTestFile(user._id, directory._id, {
			objectKey: fileKey(),
			status: "pending",
		});
		stockBucket([aged(file.objectKey)]);

		const report = await scanForOrphans();

		expect(report.owned).toBe(1);
		expect(report.candidates).toEqual([]);
	});

	it("treats an object claimed by a user's profile picture as owned", async () => {
		const user = await createTestUser();
		const key = pictureKey(user._id.toString());
		await User.updateOne({ _id: user._id }, { profilePictureKey: key });
		stockBucket([aged(key)]);

		const report = await scanForOrphans();

		expect(report.scanned).toBe(1);
		expect(report.owned).toBe(1);
		expect(report.candidates).toEqual([]);
	});

	// D5 again, from the other side: soft delete leaves the object live.
	it("treats a soft-deleted user's profile picture as owned", async () => {
		const user = await createTestUser({ deletedAt: new Date() });
		const key = pictureKey(user._id.toString());
		await User.updateOne({ _id: user._id }, { profilePictureKey: key });
		stockBucket([aged(key)]);

		const report = await scanForOrphans();

		expect(report.owned).toBe(1);
		expect(report.candidates).toEqual([]);
	});

	// The safety property the whole age floor exists for: an upload still
	// streaming has no row yet on the profile-picture path, and its object must
	// survive the scan.
	it("never makes an object younger than the floor a candidate", async () => {
		stockBucket([fresh(fileKey())]);

		const report = await scanForOrphans();

		expect(report.scanned).toBe(1);
		expect(report.skippedTooNew).toBe(1);
		expect(report.checked).toBe(0);
		expect(report.candidates).toEqual([]);
	});

	it("skips an object whose lastModified sits exactly on the floor", async () => {
		stockBucket([aged(fileKey(), { olderBy: 0 })]);

		const report = await scanForOrphans();

		expect(report.skippedTooNew).toBe(1);
		expect(report.checked).toBe(0);
		expect(report.candidates).toEqual([]);
	});

	it("checks an object one millisecond older than the floor", async () => {
		const key = fileKey();
		stockBucket([aged(key, { olderBy: 1 })]);

		const report = await scanForOrphans();

		expect(report.skippedTooNew).toBe(0);
		expect(report.checked).toBe(1);
		expect(report.candidates).toHaveLength(1);
		expect(report.candidates[0].key).toBe(key);
	});

	it("skips an object whose lastModified is missing", async () => {
		stockBucket([{ key: fileKey(), size: 100, lastModified: undefined }]);

		const report = await scanForOrphans();

		expect(report.scanned).toBe(1);
		expect(report.skippedTooNew).toBe(1);
		expect(report.checked).toBe(0);
		expect(report.candidates).toEqual([]);
	});

	// Unlike `undefined`, these all coerce to a number below the floor, so a bare
	// `<` comparison would hand an object of unknown age to the deleter.
	it("skips an object whose lastModified is not a Date", async () => {
		for (const lastModified of [null, 0, ""]) {
			stockBucket([{ key: fileKey(), size: 100, lastModified }]);

			const report = await scanForOrphans();

			expect(report.scanned).toBe(1);
			expect(report.skippedTooNew).toBe(1);
			expect(report.checked).toBe(0);
			expect(report.candidates).toEqual([]);
		}
	});

	// D9: listObjects is the one R2 call that never runs keys through assertKey,
	// so anything outside the two shapes is reported and left alone.
	it("reports a key matching neither pattern as unrecognized", async () => {
		stockBucket([
			aged("files/pre-migration-leftover.txt"),
			aged("profile-pictures/manual-upload.png"),
		]);

		const report = await scanForOrphans();

		expect(report.scanned).toBe(2);
		expect(report.unrecognized).toBe(2);
		expect(report.checked).toBe(0);
		expect(report.candidates).toEqual([]);
	});

	// S3 prefix matching is plain string matching, so "files" also lists
	// "files-archive/…" — which inflates `scanned`, the breaker's denominator.
	it("lists each prefix with a trailing slash", async () => {
		await scanForOrphans();

		expect(listObjects.mock.calls.map((call) => call[0])).toEqual([
			`${FILE_PREFIX}/`,
			`${PROFILE_PICTURE_PREFIX}/`,
		]);
	});

	it("follows the continuation token until every page is scanned", async () => {
		const keys = [fileKey(), fileKey(), fileKey()];
		stockBucket(
			keys.map((key) => aged(key)),
			{ pageSize: 1 },
		);

		const report = await scanForOrphans();

		expect(report.scanned).toBe(3);
		expect(report.checked).toBe(3);
		expect(report.candidates.map((candidate) => candidate.key)).toEqual(keys);
	});

	// A partial scan corrupts the breaker's denominator in either direction, so
	// it must never reach a delete.
	it("propagates a listObjects failure instead of scanning partially", async () => {
		listObjects.mockRejectedValueOnce(new Error("throttled"));

		await expect(scanForOrphans()).rejects.toThrow("throttled");
		expect(deleteObjects).not.toHaveBeenCalled();
	});

	// The catastrophic case: swallowed, a failed $in reads as "no row owns
	// these keys" and makes the whole bucket look orphaned.
	it("propagates an $in failure instead of reading it as zero owners", async () => {
		stockBucket([aged(fileKey()), aged(fileKey())], { pageSize: 1 });

		const originalFind = File.find.bind(File);
		vi.spyOn(File, "find")
			.mockImplementationOnce((...args) => originalFind(...args))
			.mockImplementationOnce(() => {
				throw new Error("connection reset by peer");
			});

		await expect(scanForOrphans()).rejects.toThrow("connection reset by peer");
		expect(deleteObjects).not.toHaveBeenCalled();
	});

	it("keeps its counters consistent across a mixed bucket", async () => {
		const user = await createTestUser();
		const directory = await createTestDirectory(user._id);
		const claimed = await createTestFile(user._id, directory._id, {
			objectKey: fileKey(),
		});
		const claimedPicture = pictureKey(user._id.toString());
		await User.updateOne(
			{ _id: user._id },
			{ profilePictureKey: claimedPicture },
		);

		stockBucket([
			aged(fileKey()),
			aged(claimed.objectKey),
			fresh(fileKey()),
			aged("files/pre-migration-leftover.txt"),
			aged(claimedPicture),
			aged(pictureKey()),
			{ key: pictureKey(), size: 100, lastModified: undefined },
		]);

		const report = await scanForOrphans();

		expect(report).toMatchObject({
			scanned: 7,
			unrecognized: 1,
			skippedTooNew: 2,
			checked: 4,
			owned: 2,
		});
		expect(report.candidates).toHaveLength(2);

		expect(report.scanned).toBe(
			report.unrecognized + report.skippedTooNew + report.checked,
		);
		expect(report.checked).toBe(report.owned + report.candidates.length);
	});
});

describe("reclaimOrphans", () => {
	// A broken projection or a dropped connection yields an empty owner set,
	// which makes the entire bucket look reclaimable.
	it("refuses to delete when the orphan ratio exceeds the threshold", async () => {
		const keys = [fileKey(), fileKey(), fileKey(), fileKey(), fileKey()];
		stockBucket(keys.map((key) => aged(key)));

		const report = await scanForOrphans();
		expect(report.candidates).toHaveLength(5);

		await expect(
			reclaimOrphans(report.candidates, { scanned: report.scanned }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "ORPHAN_RATIO_EXCEEDED",
		});
		expect(deleteObjects).not.toHaveBeenCalled();
	});

	it("reclaims the same run when maxRatio is raised", async () => {
		const keys = [fileKey(), fileKey(), fileKey(), fileKey(), fileKey()];
		stockBucket(keys.map((key) => aged(key)));

		const report = await scanForOrphans();

		const result = await reclaimOrphans(report.candidates, {
			scanned: report.scanned,
			maxRatio: 1,
		});

		expect(deleteObjects).toHaveBeenCalledWith(keys);
		expect(result).toEqual({ ratio: 1, deleted: keys, errors: [] });
	});

	it("passes per-key delete errors through instead of swallowing them", async () => {
		const removed = fileKey();
		const refused = fileKey();
		const errors = [
			{ key: refused, code: "AccessDenied", message: "Access Denied" },
		];
		deleteObjects.mockResolvedValue({ deleted: [removed], errors });

		const result = await reclaimOrphans(
			[{ key: removed }, { key: refused }],
			{ scanned: 20 },
		);

		expect(result.deleted).toEqual([removed]);
		expect(result.errors).toEqual(errors);
	});

	it("reports a ratio of 0 for an empty bucket rather than NaN", async () => {
		const report = await scanForOrphans();
		expect(report.scanned).toBe(0);

		const result = await reclaimOrphans(report.candidates, {
			scanned: report.scanned,
		});

		// A NaN ratio here would be a divide-by-zero dressed up as a safe run.
		expect(result).toEqual({ ratio: 0, deleted: [], errors: [] });
	});

	// Not in the spec's case list: the breaker aborts above the limit, so a run
	// sitting exactly on it must still be allowed through.
	it("permits a run sitting exactly on the threshold", async () => {
		const key = fileKey();

		const result = await reclaimOrphans([{ key }], { scanned: 5 });

		expect(result.ratio).toBe(DEFAULT_MAX_ORPHAN_RATIO);
		expect(deleteObjects).toHaveBeenCalledWith([key]);
	});

	// Not in the spec's case list either: `scanned` is what makes the ratio
	// meaningful, so a caller that loses it must fail closed rather than sail
	// past a breaker that can no longer compute anything.
	it("trips the breaker when the denominator is unusable", async () => {
		await expect(
			reclaimOrphans([{ key: fileKey() }], {}),
		).rejects.toMatchObject({ code: "ORPHAN_RATIO_EXCEEDED" });
		expect(deleteObjects).not.toHaveBeenCalled();
	});

	// A denominator that merely divides is not a guard: -1 yields a negative
	// ratio, "100" divides like a number, and Infinity yields 0 — all under any
	// threshold.
	it("refuses a denominator that is not a non-negative integer", async () => {
		for (const scanned of [-1, "100", 1.5, NaN, "abc", null, Infinity]) {
			await expect(
				reclaimOrphans([{ key: fileKey() }], { scanned }),
			).rejects.toMatchObject({ code: "ORPHAN_RATIO_EXCEEDED" });
		}

		expect(deleteObjects).not.toHaveBeenCalled();
	});

	// More candidates than objects scanned means the two numbers came from
	// different runs; a raised maxRatio would otherwise let the pair through.
	it("refuses a denominator smaller than the candidate set", async () => {
		await expect(
			reclaimOrphans([{ key: fileKey() }, { key: fileKey() }], {
				scanned: 1,
				maxRatio: 5,
			}),
		).rejects.toMatchObject({ code: "ORPHAN_RATIO_EXCEEDED" });
		expect(deleteObjects).not.toHaveBeenCalled();
	});
});

describe("SCANNED_PREFIXES", () => {
	// Exported so a caller reporting "across N prefixes" reads the real list
	// instead of keeping its own copy to fall out of date.
	it("names every prefix the scan covers", () => {
		expect(SCANNED_PREFIXES).toEqual([FILE_PREFIX, PROFILE_PICTURE_PREFIX]);
	});
});
