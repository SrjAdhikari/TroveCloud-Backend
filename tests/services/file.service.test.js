import { afterEach, describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import mongoose from "mongoose";

import {
	MIN_UPLOAD_BYTES_PER_SECOND,
	MAX_EXPIRED_FILES_PER_SWEEP,
	getFile,
	createDownloadUrl,
	deleteFile,
	uploadFileFromServer,
	updateFile,
	initiateUpload,
	confirmUpload,
} from "../../src/services/file.service.js";
import envConfig from "../../src/constants/env.js";

const { MAX_FILE_UPLOAD_SIZE } = envConfig;
import {
	getObjectMetadata,
	putObject,
	deleteObject,
	UPLOAD_URL_TTL_SECONDS,
	DOWNLOAD_URL_TTL_SECONDS,
} from "../../src/lib/r2.js";
import File from "../../src/models/file.model.js";
import Directory from "../../src/models/directory.model.js";
import {
	ONE_MINUTE_MS,
	FIFTEEN_MINUTES_MS,
	ONE_HOUR_MS,
} from "../../src/utils/date.js";

import {
	createTestUser,
	createTestDirectory,
	createTestFile,
} from "../factories.js";

// Objects really land in the dev R2 bucket, so every key a test creates is
// tracked and removed even when the assertion after it fails. `tests/setup.js`
// resolves whatever a surviving document still names; this catches the rest.
const createdKeys = new Set();

const trackObjectKey = async (fileId) => {
	const { objectKey } = await File.findById(fileId).select("+objectKey").lean();
	createdKeys.add(objectKey);
	return objectKey;
};

// Stands in for bytes a previous upload left at the document's own key.
const putObjectFor = async (file) => {
	await putObject(file.objectKey, Readable.from(["owner bytes"]), {
		contentType: "application/octet-stream",
	});
	createdKeys.add(file.objectKey);
	return file.objectKey;
};

const objectExists = async (key) => Boolean(await getObjectMetadata(key));

afterEach(async () => {
	await Promise.allSettled(
		[...createdKeys].map(async (key) => {
			// try/catch around the whole call — `assertKey` inside `deleteObject`
			// throws synchronously for a malformed key, which `.catch()` misses.
			try {
				await deleteObject(key);
			} catch {}
		}),
	);
	createdKeys.clear();

	vi.restoreAllMocks();
});

describe("file.service ownership isolation", () => {
	it("deleteFile by a non-owner throws FILE_NOT_FOUND and leaves the owner's file intact", async () => {
		const owner = await createTestUser();
		const attacker = await createTestUser();
		const dir = await createTestDirectory(owner._id);
		const file = await createTestFile(owner._id, dir._id);
		const key = await putObjectFor(file);

		await expect(deleteFile(file._id, attacker._id)).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
			statusCode: 404,
		});

		// The cross-user attempt must touch neither the DB row nor the object.
		expect(await File.exists({ _id: file._id })).not.toBeNull();
		expect(await objectExists(key)).toBe(true);
	});

	it("getFile by a non-owner throws FILE_NOT_FOUND", async () => {
		const owner = await createTestUser();
		const attacker = await createTestUser();
		const dir = await createTestDirectory(owner._id);
		const file = await createTestFile(owner._id, dir._id);

		await expect(getFile(file._id, attacker._id)).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
			statusCode: 404,
		});
	});

	// Positive control: proves the isolation tests above fail for the right
	// reason (ownership), not because delete is silently a no-op.
	it("deleteFile by the owner removes both the DB row and the stored object", async () => {
		const owner = await createTestUser();
		const dir = await createTestDirectory(owner._id);
		const file = await createTestFile(owner._id, dir._id);
		const key = await putObjectFor(file);

		await deleteFile(file._id, owner._id);

		expect(await File.exists({ _id: file._id })).toBeNull();
		expect(await objectExists(key)).toBe(false);
	});
});

const dirStats = async (id) => {
	const d = await Directory.findById(id);
	return { size: d.size, fileCount: d.fileCount };
};

const expire = async (fileId) =>
	File.updateOne(
		{ _id: fileId },
		{ uploadExpiresAt: new Date(Date.now() - ONE_MINUTE_MS) },
	);

// The limit is always explicit: `uploadFileFromServer` defaults to the declared
// server-side exemption, and a test must not silently ride on it.
const upload = async (parentId, userId, name, body, storageLimit = 10 ** 9) => {
	const file = await uploadFileFromServer(
		parentId,
		userId,
		name,
		Readable.from(Buffer.from(body)),
		storageLimit,
	);
	createdKeys.add(file.objectKey);
	return file;
};

describe("uploadFileFromServer", () => {
	it("stores the bytes in R2 and creates a ready file with its key", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const file = await uploadFileFromServer(
			dir._id,
			user._id,
			"imported.txt",
			Readable.from(["from ", "drive"]),
			1_000_000,
		);
		createdKeys.add(file.objectKey);

		expect(file.status).toBe("ready");
		expect(file.size).toBe(10);
		expect(file.objectKey).toMatch(/^files\/[a-f0-9]{24}-[a-f0-9]{32}\.txt$/);
		expect((await getObjectMetadata(file.objectKey)).size).toBe(10);
	});

	it("stores the content type the extension maps to", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const file = await uploadFileFromServer(
			dir._id,
			user._id,
			"typed.txt",
			Readable.from(["x"]),
			1_000_000,
		);
		createdKeys.add(file.objectKey);

		// Stored, never recomputed later: confirm compares against
		// the type pinned at creation.
		expect(file.contentType).toBe("text/plain; charset=utf-8");
		expect((await getObjectMetadata(file.objectKey)).contentType).toBe(
			"text/plain; charset=utf-8",
		);
	});

	it("lowercases the extension like the mint path does", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const file = await uploadFileFromServer(
			dir._id,
			user._id,
			"Imported.TXT",
			Readable.from(["x"]),
			1_000_000,
		);
		createdKeys.add(file.objectKey);

		expect(file.extension).toBe(".txt");
		expect(await getObjectMetadata(file.objectKey)).not.toBeNull();
	});

	it("rejects a name without a simple extension, before touching R2", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		for (const name of ["README", "module.c++", "trailing."]) {
			await expect(
				uploadFileFromServer(
					dir._id,
					user._id,
					name,
					Readable.from(["x"]),
					1_000_000,
				),
			).rejects.toMatchObject({ code: "INVALID_INPUT", statusCode: 400 });
		}

		expect(await File.countDocuments({ userId: user._id })).toBe(0);
	});

	it("stores nothing when the quota check rejects", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await expect(
			uploadFileFromServer(
				dir._id,
				user._id,
				"big.txt",
				Readable.from(["0123456789"]),
				5,
			),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });

		expect(await File.countDocuments({ userId: user._id })).toBe(0);
	});

	it("aborts and stores nothing when the stream exceeds the per-file cap", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await expect(
			uploadFileFromServer(
				dir._id,
				user._id,
				"big.bin",
				Readable.from([Buffer.alloc(1024)]),
				10 ** 9,
				512,
			),
		).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

		expect(await File.countDocuments({ userId: user._id })).toBe(0);
	});

	it("destroys the source stream when the upload fails", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const source = Readable.from([Buffer.alloc(1024)]);

		await expect(
			uploadFileFromServer(
				dir._id,
				user._id,
				"big.bin",
				source,
				10 ** 9,
				512,
			),
		).rejects.toThrow();

		// `pipeline` tears down the whole chain. With a bare `.pipe()` the source
		// would stay open — in the Drive path that is a leaked HTTPS socket.
		expect(source.destroyed).toBe(true);
	});
});

describe("uploadFileFromServer maintains folder sizes", () => {
	it("increments the target folder and all ancestors by the streamed bytes", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const sub = await createTestDirectory(user._id, { parentDirId: root._id });

		const file = await upload(sub._id, user._id, "note.txt", "hello world"); // 11 bytes

		expect(file.size).toBe(11);
		expect(await dirStats(sub._id)).toEqual({ size: 11, fileCount: 1 });
		expect(await dirStats(root._id)).toEqual({ size: 11, fileCount: 1 });
	});

	it("counts an empty file (0 bytes) toward fileCount but not size (boundary)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const file = await upload(root._id, user._id, "empty.txt", "");

		expect(file.size).toBe(0);
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 1 });
	});

	it("accumulates across multiple uploads into the same folder", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		await upload(root._id, user._id, "a.txt", "aaa"); // 3
		await upload(root._id, user._id, "b.txt", "bbbb"); // 4

		expect(await dirStats(root._id)).toEqual({ size: 7, fileCount: 2 });
	});

	it("updates every ancestor in a deep tree (worst case depth)", async () => {
		const user = await createTestUser();
		let parentDirId = null;
		const dirs = [];
		for (let i = 0; i < 4; i++) {
			const d = await createTestDirectory(user._id, { parentDirId });
			dirs.push(d);
			parentDirId = d._id;
		}

		await upload(dirs[3]._id, user._id, "deep.txt", "12345"); // 5 bytes

		for (const d of dirs) {
			expect(await dirStats(d._id)).toEqual({ size: 5, fileCount: 1 });
		}
	});

	it("throws DIRECTORY_NOT_FOUND for a missing parent and writes nothing (error path)", async () => {
		const user = await createTestUser();
		const ghost = new mongoose.Types.ObjectId();

		await expect(
			uploadFileFromServer(
				ghost,
				user._id,
				"x.txt",
				Readable.from(Buffer.from("x")),
				1_000_000,
			),
		).rejects.toMatchObject({ code: "DIRECTORY_NOT_FOUND", statusCode: 404 });

		expect(await File.countDocuments({})).toBe(0);
	});

	it("rejects a parent owned by another user, leaving it untouched (security)", async () => {
		const owner = await createTestUser();
		const attacker = await createTestUser();
		const dir = await createTestDirectory(owner._id);

		await expect(
			uploadFileFromServer(
				dir._id,
				attacker._id,
				"x.txt",
				Readable.from(Buffer.from("x")),
				1_000_000,
			),
		).rejects.toMatchObject({ code: "DIRECTORY_NOT_FOUND" });

		expect(await dirStats(dir._id)).toEqual({ size: 0, fileCount: 0 });
		expect(await File.countDocuments({})).toBe(0);
	});

	it("rolls back fully when the stream errors (no doc, no size change, worst case)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const sub = await createTestDirectory(user._id, { parentDirId: root._id });

		const boom = new Readable({
			read() {
				this.destroy(new Error("stream boom"));
			},
		});

		await expect(uploadFileFromServer(sub._id, user._id, "x.txt", boom, 1_000_000)).rejects.toMatchObject({
			code: "FILE_UPLOAD_FAILED",
		});

		expect(await File.countDocuments({})).toBe(0);
		expect(await dirStats(sub._id)).toEqual({ size: 0, fileCount: 0 });
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });
	});
});

describe("uploadFileFromServer enforces per-user storage quota", () => {
	it("rejects an upload that would exceed the user's remaining quota", async () => {
		const user = await createTestUser({ storageLimit: 5 });
		const root = await createTestDirectory(user._id); // parentDirId: null → root

		await expect(
			uploadFileFromServer(
				root._id,
				user._id,
				"big.txt",
				Readable.from(Buffer.from("123456")), // 6 bytes
				user.storageLimit,
			),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED", statusCode: 400 });

		expect(await File.countDocuments({})).toBe(0);
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("allows an upload that exactly fills the quota (boundary)", async () => {
		const user = await createTestUser({ storageLimit: 6 });
		const root = await createTestDirectory(user._id);

		const file = await upload(root._id, user._id, "fit.txt", "123456", user.storageLimit); // 6 bytes

		expect(file.size).toBe(6);
		expect(await dirStats(root._id)).toEqual({ size: 6, fileCount: 1 });
	});

	it("checks against live usage from prior uploads, not just the new file", async () => {
		const user = await createTestUser({ storageLimit: 10 });
		const root = await createTestDirectory(user._id);

		await upload(root._id, user._id, "a.txt", "12345", user.storageLimit); // 5 bytes → used 5

		await expect(
			uploadFileFromServer(
				root._id,
				user._id,
				"b.txt",
				Readable.from(Buffer.from("123456")), // +6 → 11 > 10
				user.storageLimit,
			),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });

		expect(await File.countDocuments({})).toBe(1);
		expect(await dirStats(root._id)).toEqual({ size: 5, fileCount: 1 });
	});

	it("rejects a new upload when the quota is already full", async () => {
		const user = await createTestUser({ storageLimit: 5 });
		const root = await createTestDirectory(user._id, { size: 5, fileCount: 1 });

		await expect(
			uploadFileFromServer(
				root._id,
				user._id,
				"x.txt",
				Readable.from(Buffer.from("x")), // 1 byte
				user.storageLimit,
			),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });

		expect(await dirStats(root._id)).toEqual({ size: 5, fileCount: 1 });
	});

	it("allows a 0-byte upload even at exactly full quota (boundary)", async () => {
		const user = await createTestUser({ storageLimit: 5 });
		const root = await createTestDirectory(user._id, { size: 5, fileCount: 1 });

		const file = await upload(root._id, user._id, "empty.txt", "", user.storageLimit); // 0 bytes

		expect(file.size).toBe(0);
		expect(await dirStats(root._id)).toEqual({ size: 5, fileCount: 2 });
	});
});

describe("uploadFileFromServer claims the row before writing bytes", () => {
	// Snapshots the DB while the bytes are still in flight.
	const watchingStream = (body, snapshot) => {
		let observed = false;

		return new Readable({
			read() {
				if (observed) return;
				observed = true;

				snapshot()
					.then(() => {
						this.push(Buffer.from(body));
						this.push(null);
					})
					// Without this a rejected snapshot hangs the test instead of naming the cause.
					.catch((err) => this.destroy(err));
			},
		});
	};

	it("has a pending 0-byte row naming the key before the bytes are read", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		let claimed = null;
		const source = watchingStream("mid flight", async () => {
			claimed = await File.findOne({ userId: user._id })
				.select("+objectKey")
				.lean();
		});

		const file = await uploadFileFromServer(
			root._id,
			user._id,
			"claim.txt",
			source,
			10 ** 9,
		);
		createdKeys.add(file.objectKey);

		// Without a row naming the key, a failed transaction strands the object in R2.
		expect(claimed).toMatchObject({ status: "pending", size: 0 });
		expect(claimed.objectKey).toBe(file.objectKey);
		expect(claimed.uploadExpiresAt).toBeInstanceOf(Date);
	});

	const erroringStream = (snapshot) => {
		let observed = false;

		return new Readable({
			read() {
				if (observed) return;
				observed = true;

				snapshot()
					.then(() => this.destroy(new Error("stream boom")))
					.catch((err) => this.destroy(err));
			},
		});
	};

	const claimOf = (user) => async () =>
		File.findOne({ userId: user._id }).select("+objectKey").lean();

	it("undoes the claim, the object, and the stats when the bytes never land", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const sub = await createTestDirectory(user._id, { parentDirId: root._id });

		let claimed = null;
		const snapshot = claimOf(user);
		const source = erroringStream(async () => {
			claimed = await snapshot();
		});

		await expect(
			uploadFileFromServer(sub._id, user._id, "torn.txt", source, 10 ** 9),
		).rejects.toMatchObject({ code: "FILE_UPLOAD_FAILED", statusCode: 500 });
		createdKeys.add(claimed.objectKey);

		// The claim's +1 file has to come back too, or every ancestor drifts.
		expect(await File.countDocuments({})).toBe(0);
		expect(await objectExists(claimed.objectKey)).toBe(false);
		expect(await dirStats(sub._id)).toEqual({ size: 0, fileCount: 0 });
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("undoes the claim, the object, and the stats when the quota rejects", async () => {
		const user = await createTestUser({ storageLimit: 5 });
		const root = await createTestDirectory(user._id);

		let claimed = null;
		const snapshot = claimOf(user);
		const source = watchingStream("123456", async () => {
			claimed = await snapshot();
		});

		await expect(
			uploadFileFromServer(
				root._id,
				user._id,
				"over.txt",
				source,
				user.storageLimit,
			),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED", statusCode: 400 });
		createdKeys.add(claimed.objectKey);

		expect(await File.countDocuments({})).toBe(0);
		expect(await objectExists(claimed.objectKey)).toBe(false);
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("ends ready at the counted size, expiry cleared, stats moved exactly once", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const sub = await createTestDirectory(user._id, { parentDirId: root._id });

		const file = await upload(sub._id, user._id, "note.txt", "hello world"); // 11

		expect(file.status).toBe("ready");
		expect(file.size).toBe(11);
		expect(file.uploadExpiresAt).toBeUndefined();
		expect((await getObjectMetadata(file.objectKey)).size).toBe(11);

		expect(await dirStats(sub._id)).toEqual({ size: 11, fileCount: 1 });
		expect(await dirStats(root._id)).toEqual({ size: 11, fileCount: 1 });
	});

	it("clears the expiry on a 0-byte import, so it is not a live reservation", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const file = await upload(root._id, user._id, "empty.txt", "");
		const stored = await File.findById(file._id).lean();

		// A 0-byte flip changes no size, so only the $unset separates it from its claim.
		expect(stored).toMatchObject({ status: "ready", size: 0 });
		expect(stored.uploadExpiresAt).toBeUndefined();
		await expect(deleteFile(file._id, user._id)).resolves.toMatchObject({
			name: "empty.txt",
		});
	});

	it("fails and cleans up when the claim is swept out from under the flip", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		let claimed = null;
		const source = watchingStream("racing", async () => {
			claimed = await File.findOne({ userId: user._id })
				.select("+objectKey")
				.lean();

			// Stands in for the sweep collecting this claim mid-upload.
			await File.deleteOne({ _id: claimed._id });
			await Directory.updateOne({ _id: root._id }, { $inc: { fileCount: -1 } });
		});

		await expect(
			uploadFileFromServer(root._id, user._id, "raced.txt", source, 10 ** 9),
		).rejects.toMatchObject({ code: "FILE_UPLOAD_FAILED", statusCode: 500 });
		createdKeys.add(claimed.objectKey);

		// Promoting a swept row would resurrect a file already refunded.
		expect(await File.countDocuments({})).toBe(0);
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });

		// The object stays: a vanished row may have been promoted instead, and dropping it would strip a live file.
		expect(await objectExists(claimed.objectKey)).toBe(true);
	});

	it("leaves a killed import's claim for the expiry sweep to collect", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const abandoned = await createTestFile(user._id, root._id, {
			status: "pending",
			size: 0,
		});
		const objectKey = await putObjectFor(abandoned);
		await File.updateOne(
			{ _id: abandoned._id },
			{ uploadExpiresAt: new Date(Date.now() - ONE_MINUTE_MS) },
		);
		await Directory.updateOne({ _id: root._id }, { $inc: { fileCount: 1 } });

		await initiateUpload(root._id, user._id, "fresh.txt", 100, 10 ** 9);

		expect(await File.findById(abandoned._id)).toBeNull();
		expect(await objectExists(objectKey)).toBe(false);
		expect(await dirStats(root._id)).toEqual({ size: 100, fileCount: 1 });
	});

	it("reports FILE_UPLOAD_FAILED when the claim itself cannot be written", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		vi.spyOn(File, "create").mockRejectedValueOnce(
			new mongoose.Error.ValidationError(),
		);

		// Unwrapped, a driver failure escapes as a non-AppError the handler can only render as opaque.
		await expect(
			uploadFileFromServer(
				root._id,
				user._id,
				"claim.txt",
				Readable.from(["x"]),
				10 ** 9,
			),
		).rejects.toMatchObject({ code: "FILE_UPLOAD_FAILED", statusCode: 500 });

		expect(await File.countDocuments({})).toBe(0);
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("still reports FILE_TOO_LARGE when releasing the claim fails", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(File, "deleteOne").mockRejectedValueOnce(new Error("mongo down"));

		// The release runs first in the catch, so a throw there would replace the classification below it.
		await expect(
			uploadFileFromServer(
				root._id,
				user._id,
				"huge.bin",
				Readable.from([Buffer.alloc(1024)]),
				10 ** 9,
				512,
			),
		).rejects.toMatchObject({ code: "FILE_TOO_LARGE", statusCode: 400 });

		const claim = await File.findOne({ userId: user._id })
			.select("+objectKey")
			.lean();
		const logged = warn.mock.calls.flat().join(" ");

		expect(logged).toContain(String(claim._id));
		// The key's nonce is what makes another user's object unguessable.
		expect(logged).not.toContain(claim.objectKey);
	});

	it("undoes the claim and still reports FILE_TOO_LARGE when the cap trips", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		let claimed = null;
		const snapshot = claimOf(user);
		const source = watchingStream(Buffer.alloc(1024), async () => {
			claimed = await snapshot();
		});

		await expect(
			uploadFileFromServer(root._id, user._id, "huge.bin", source, 10 ** 9, 512),
		).rejects.toMatchObject({ code: "FILE_TOO_LARGE", statusCode: 400 });
		createdKeys.add(claimed.objectKey);

		expect(await File.countDocuments({})).toBe(0);
		expect(await objectExists(claimed.objectKey)).toBe(false);
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });
	});
});

describe("deleteFile maintains folder sizes", () => {
	it("decrements the folder and ancestors back to zero on the last file", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const sub = await createTestDirectory(user._id, { parentDirId: root._id });
		const file = await upload(sub._id, user._id, "note.txt", "hello world"); // 11

		await deleteFile(file._id, user._id);

		expect(await dirStats(sub._id)).toEqual({ size: 0, fileCount: 0 });
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("removes only the deleted file's contribution (isolation)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const f1 = await upload(root._id, user._id, "a.txt", "aaa"); // 3
		await upload(root._id, user._id, "b.txt", "bbbb"); // 4

		await deleteFile(f1._id, user._id);

		expect(await dirStats(root._id)).toEqual({ size: 4, fileCount: 1 });
	});

	it("decrements every ancestor for a nested file (depth)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const sub = await createTestDirectory(user._id, { parentDirId: root._id });
		const file = await upload(sub._id, user._id, "n.txt", "12345"); // 5

		await deleteFile(file._id, user._id);

		expect(await dirStats(sub._id)).toEqual({ size: 0, fileCount: 0 });
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("does not refund a row a concurrent sweep already removed", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const file = await upload(root._id, user._id, "raced.txt", "bytes"); // 5

		vi.spyOn(File, "deleteOne").mockImplementationOnce(async () => {
			// Raw collection: in-transaction, a WriteConflict retry hides the deletedCount === 0 branch.
			await File.collection.deleteOne({ _id: file._id });
			await Directory.updateOne(
				{ _id: root._id },
				{ $inc: { size: -5, fileCount: -1 } },
			);
			return { acknowledged: true, deletedCount: 0 };
		});

		await deleteFile(file._id, user._id);

		// Refunding twice drives the ancestors negative.
		expect(await dirStats(root._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("leaves sizes unchanged when a non-owner attempts delete (security)", async () => {
		const owner = await createTestUser();
		const attacker = await createTestUser();
		const root = await createTestDirectory(owner._id);
		const file = await upload(root._id, owner._id, "a.txt", "aaa"); // 3

		await expect(deleteFile(file._id, attacker._id)).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
		});

		expect(await dirStats(root._id)).toEqual({ size: 3, fileCount: 1 });
	});
});

describe("deleteFile refuses a live reservation", () => {
	it("removes the document, refunds the stats, and deletes the object", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const file = await upload(root._id, user._id, "gone.txt", "bytes"); // 5

		await deleteFile(file._id, user._id);

		expect(await File.findById(file._id)).toBeNull();
		expect(await getObjectMetadata(file.objectKey)).toBeNull();
		expect((await Directory.findById(root._id).lean()).size).toBe(0);
	});

	it("refuses to delete a pending reservation, and says why", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const mint = await initiateUpload(
			root._id,
			user._id,
			"wip.txt",
			500,
			1_000_000,
		);

		// Invariant 1: refunding now would let the still-live URL land bytes
		// nothing accounts for. A distinct code lets the client explain itself.
		await expect(deleteFile(mint.fileId, user._id)).rejects.toMatchObject({
			code: "UPLOAD_IN_PROGRESS",
			statusCode: 409,
		});

		expect((await File.findById(mint.fileId).select("+objectKey").lean()).status).toBe("pending");
		expect((await Directory.findById(root._id).lean()).size).toBe(500);
	});

	it("deletes and refunds once the upload window has closed", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const mint = await initiateUpload(
			root._id,
			user._id,
			"stale.txt",
			500,
			1_000_000,
		);
		await File.updateOne(
			{ _id: mint.fileId },
			{ uploadExpiresAt: new Date(Date.now() - 1000) },
		);

		// Past the deadline the presigned URL is dead, so nothing can land
		// afterwards and the bytes are safe to hand back. Without this the
		// account is wedged forever: no reaper, and delete used to 409.
		await expect(deleteFile(mint.fileId, user._id)).resolves.toMatchObject({
			name: "stale.txt",
		});

		expect(await File.findById(mint.fileId)).toBeNull();
		expect((await Directory.findById(root._id).lean()).size).toBe(0);
	});
});

describe("updateFile scopes renames to ready files", () => {
	it("renames a ready file", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const file = await upload(dir._id, user._id, "before.txt", "x");

		const renamed = await updateFile(file._id, "after.txt", user._id);

		expect(renamed.name).toBe("after.txt");
	});

	it("does not rename a pending reservation", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const mint = await initiateUpload(
			dir._id,
			user._id,
			"wip.txt",
			10,
			1_000_000,
		);

		// Invariant 4: a reservation is quota bookkeeping, not a file the user has.
		await expect(
			updateFile(mint.fileId, "renamed.txt", user._id),
		).rejects.toMatchObject({ code: "FILE_NOT_FOUND", statusCode: 404 });

		expect((await File.findById(mint.fileId).select("+objectKey").lean()).name).toBe("wip.txt");
	});
});

describe("initiateUpload", () => {
	it("reserves the declared bytes and returns a presigned PUT", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const result = await initiateUpload(dir._id, user._id, "notes.txt", 1024, 1_000_000);

		expect(result.uploadUrl).toContain("X-Amz-Signature");
		expect(result.contentType).toBe("text/plain; charset=utf-8");

		// The whole quota model rests on this: an unsigned content-length is an
		// unbounded upload URL, and the reservation would stop bounding anything.
		const signedHeaders = new URL(result.uploadUrl).searchParams.get(
			"X-Amz-SignedHeaders",
		);
		expect(signedHeaders).toContain("content-length");
		expect(signedHeaders).toContain("content-type");

		const reserved = await File.findById(result.fileId)
			.select("+objectKey")
			.lean();
		expect(reserved.status).toBe("pending");
		expect(reserved.size).toBe(1024);
		expect(reserved.contentType).toBe("text/plain; charset=utf-8");
		expect(reserved.uploadExpiresAt).toBeInstanceOf(Date);
		expect(reserved.objectKey).toMatch(/^files\/[a-f0-9]{24}-[a-f0-9]{32}\.txt$/);
	});

	it("returns the URL TTL and the reservation deadline as separate fields", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const result = await initiateUpload(dir._id, user._id, "notes.txt", 1024, 1_000_000);
		const reserved = await File.findById(result.fileId)
			.select("+objectKey")
			.lean();

		// The client needs its real budget, not just how long the URL is mintable.
		expect(result.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
			UPLOAD_URL_TTL_SECONDS * 1000,
		);
		expect(result.uploadExpiresAt.getTime()).toBe(reserved.uploadExpiresAt.getTime());
		expect(result.uploadExpiresAt.getTime()).toBeGreaterThan(result.expiresAt.getTime());
	});

	it("stores a key the URL actually targets, and does not derive it from the id alone", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const result = await initiateUpload(dir._id, user._id, "notes.txt", 10, 1_000_000);
		const reserved = await File.findById(result.fileId)
			.select("+objectKey")
			.lean();

		expect(decodeURIComponent(result.uploadUrl)).toContain(reserved.objectKey);
		// The nonce is what makes it unguessable from the id.
		expect(reserved.objectKey).not.toBe(`files/${result.fileId}.txt`);
	});

	it("counts the reservation against ancestor stats immediately", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		await initiateUpload(root._id, user._id, "notes.txt", 4096, 1_000_000);

		const updated = await Directory.findById(root._id).lean();
		expect(updated.size).toBe(4096);
		expect(updated.fileCount).toBe(1);
	});

	it("lowercases the extension", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const result = await initiateUpload(dir._id, user._id, "Report.PDF", 100, 1_000_000);

		const reserved = await File.findById(result.fileId)
			.select("+objectKey")
			.lean();
		expect(reserved.extension).toBe(".pdf");
		expect(result.contentType).toBe("application/pdf");
		expect(reserved.objectKey.endsWith(".pdf")).toBe(true);
	});

	it("sizes the reservation window to outlive the URL plus the transfer", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		// The size whose transfer estimate lands exactly on the 1-hour clamp, so
		// anything above it is clamped rather than sized by the transfer.
		const ceilingSize = (ONE_HOUR_MS / 1000) * MIN_UPLOAD_BYTES_PER_SECOND;

		const before = Date.now();
		const small = await initiateUpload(dir._id, user._id, "small.txt", 100, 10 ** 9);
		// Half the ceiling: between the 15-minute floor and the 1-hour ceiling.
		const mid = await initiateUpload(dir._id, user._id, "mid.bin", ceilingSize / 2, 10 ** 9);
		const large = await initiateUpload(dir._id, user._id, "large.bin", ceilingSize * 1.5, 10 ** 9);

		const windowOf = async (mint) =>
			(await File.findById(mint.fileId).select("+objectKey").lean()).uploadExpiresAt.getTime() - before;

		const ttlMs = UPLOAD_URL_TTL_SECONDS * 1000;
		const [smallWindow, midWindow, largeWindow] = await Promise.all([
			windowOf(small),
			windowOf(mid),
			windowOf(large),
		]);

		expect(largeWindow).toBeGreaterThan(smallWindow);

		// Invariant 1: a PUT may START as late as mint + presign TTL, so every
		// window covers the TTL *plus* the expected transfer time.
		expect(smallWindow).toBeGreaterThanOrEqual(ttlMs + FIFTEEN_MINUTES_MS);
		expect(midWindow).toBeGreaterThan(ttlMs + FIFTEEN_MINUTES_MS);
		expect(midWindow).toBeLessThan(ttlMs + ONE_HOUR_MS);

		// The ceiling is reachable and really does bound the window, rather than
		// being dead code no declared size ever reaches.
		expect(largeWindow).toBeGreaterThanOrEqual(ttlMs + ONE_HOUR_MS);
		expect(largeWindow).toBeLessThan(ttlMs + ONE_HOUR_MS + 10_000);
	});

	it("rejects a declared size over the per-file cap", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await expect(
			initiateUpload(dir._id, user._id, "huge.bin", MAX_FILE_UPLOAD_SIZE + 1, 10 ** 12),
		).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
	});

	it("rejects a size that would exceed the quota, leaving no reservation", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await expect(
			initiateUpload(dir._id, user._id, "notes.txt", 500, 100),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });

		expect(await File.countDocuments({ userId: user._id })).toBe(0);
	});

	it("counts an existing reservation against a later mint's quota", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await initiateUpload(dir._id, user._id, "first.txt", 800, 1000);

		await expect(
			initiateUpload(dir._id, user._id, "second.txt", 800, 1000),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });
	});

	it("lets only one of two CONCURRENT mints pass the quota check", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id); // parentDirId: null → root

		// Started together on purpose: awaiting the first would pass even if the
		// quota read moved outside the transaction, which is the bug this guards.
		const results = await Promise.allSettled([
			initiateUpload(root._id, user._id, "a.txt", 600, 1000),
			initiateUpload(root._id, user._id, "b.txt", 600, 1000),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason).toMatchObject({
			code: "STORAGE_LIMIT_EXCEEDED",
		});

		expect(await File.countDocuments({ userId: user._id })).toBe(1);
		expect((await Directory.findById(root._id).lean()).size).toBe(600);
	});

	it("rejects a parent directory owned by someone else", async () => {
		const owner = await createTestUser();
		const attacker = await createTestUser();
		const dir = await createTestDirectory(owner._id);

		await expect(
			initiateUpload(dir._id, attacker._id, "notes.txt", 10, 1_000_000),
		).rejects.toMatchObject({ code: "DIRECTORY_NOT_FOUND" });
	});

	it("rejects a non-positive or non-integer declared size", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		for (const size of [0, -1, 1.5, NaN, "100", null]) {
			await expect(
				initiateUpload(dir._id, user._id, "x.txt", size, 1_000_000),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	it("rejects an unsupported or absent extension without leaving a reservation", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		// The key is built before the transaction, so these are clean 400s
		// rather than pending documents nobody can confirm.
		for (const name of ["module.c++", "README", "trailing.", ".txt"]) {
			await expect(
				initiateUpload(dir._id, user._id, name, 100, 1_000_000),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
		}

		expect(await File.countDocuments({ userId: user._id })).toBe(0);
	});

	it("takes only the trailing extension from a multi-dot name", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const result = await initiateUpload(
			dir._id,
			user._id,
			"archive.tar.gz",
			100,
			1_000_000,
		);

		const reserved = await File.findById(result.fileId)
			.select("+objectKey")
			.lean();
		expect(reserved.extension).toBe(".gz");
		expect(reserved.name).toBe("archive.tar.gz");
		// Unmapped extensions fall back to a type that is never served inline.
		expect(result.contentType).toBe("application/octet-stream");
	});
});

describe("initiateUpload releases expired files", () => {
	it("deletes an expired reservation and refunds its bytes to the ancestor chain", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const sub = await createTestDirectory(user._id, { parentDirId: root._id });

		const abandoned = await initiateUpload(
			sub._id,
			user._id,
			"abandoned.txt",
			600,
			10 ** 9,
		);
		await expire(abandoned.fileId);

		await initiateUpload(sub._id, user._id, "fresh.txt", 100, 10 ** 9);

		expect(await File.findById(abandoned.fileId)).toBeNull();
		expect(await dirStats(sub._id)).toEqual({ size: 100, fileCount: 1 });
		expect(await dirStats(root._id)).toEqual({ size: 100, fileCount: 1 });
	});

	it("deletes the partial object an expired reservation left in R2", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const abandoned = await initiateUpload(
			root._id,
			user._id,
			"half.txt",
			600,
			10 ** 9,
		);
		const objectKey = await trackObjectKey(abandoned.fileId);
		await putObject(objectKey, Readable.from(["partial bytes"]), {
			contentType: abandoned.contentType,
		});
		await expire(abandoned.fileId);

		await initiateUpload(root._id, user._id, "fresh.txt", 100, 10 ** 9);

		expect(await objectExists(objectKey)).toBe(false);
	});

	it("leaves a reservation whose window is still open completely untouched", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const live = await initiateUpload(
			root._id,
			user._id,
			"live.txt",
			400,
			10 ** 9,
		);
		await initiateUpload(root._id, user._id, "next.txt", 100, 10 ** 9);

		// Its presigned URL can still land bytes; refunding now would lose them.
		const stillPending = await File.findById(live.fileId)
			.select("+objectKey")
			.lean();
		expect(stillPending.status).toBe("pending");
		expect(await dirStats(root._id)).toEqual({ size: 500, fileCount: 2 });
	});

	it("lets a user whose quota is fully consumed by expired reservations upload again", async () => {
		const user = await createTestUser({ storageLimit: 1000 });
		const root = await createTestDirectory(user._id);

		const abandoned = await initiateUpload(
			root._id,
			user._id,
			"brick.txt",
			1000,
			user.storageLimit,
		);
		await expire(abandoned.fileId);

		// Nothing else refunds an unconfirmed reservation, so without the sweep the account stays wedged.
		const fresh = await initiateUpload(
			root._id,
			user._id,
			"after.txt",
			1000,
			user.storageLimit,
		);

		expect(await File.findById(abandoned.fileId)).toBeNull();
		expect(await File.findById(fresh.fileId)).not.toBeNull();
		expect(await dirStats(root._id)).toEqual({ size: 1000, fileCount: 1 });
	});

	it("does not release another user's expired files", async () => {
		const owner = await createTestUser();
		const other = await createTestUser();
		const ownerRoot = await createTestDirectory(owner._id);
		const otherRoot = await createTestDirectory(other._id);

		const ownerStale = await initiateUpload(
			ownerRoot._id,
			owner._id,
			"mine.txt",
			300,
			10 ** 9,
		);
		const otherStale = await initiateUpload(
			otherRoot._id,
			other._id,
			"theirs.txt",
			700,
			10 ** 9,
		);
		await expire(ownerStale.fileId);
		await expire(otherStale.fileId);

		await initiateUpload(ownerRoot._id, owner._id, "fresh.txt", 50, 10 ** 9);

		expect(await File.findById(ownerStale.fileId)).toBeNull();
		expect(
			(await File.findById(otherStale.fileId).select("+objectKey").lean())
				.status,
		).toBe("pending");
		expect(await dirStats(otherRoot._id)).toEqual({ size: 700, fileCount: 1 });
	});

	it("is a clean no-op when nothing has expired", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const ready = await upload(root._id, user._id, "kept.txt", "hello"); // 5

		const mint = await initiateUpload(root._id, user._id, "new.txt", 100, 10 ** 9);

		expect(mint.uploadUrl).toContain("X-Amz-Signature");
		expect(await File.countDocuments({ userId: user._id })).toBe(2);
		expect(await objectExists(ready.objectKey)).toBe(true);
		expect(await dirStats(root._id)).toEqual({ size: 105, fileCount: 2 });
	});

	it("never releases a ready file carrying a stale expiry (status guard)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const ready = await upload(root._id, user._id, "confirmed.txt", "hello"); // 5

		await File.updateOne(
			{ _id: ready._id },
			{ uploadExpiresAt: new Date(Date.now() - ONE_MINUTE_MS) },
		);

		await initiateUpload(root._id, user._id, "next.txt", 100, 10 ** 9);

		expect(await File.findById(ready._id)).not.toBeNull();
		expect(await objectExists(ready.objectKey)).toBe(true);
		expect(await dirStats(root._id)).toEqual({ size: 105, fileCount: 2 });
	});

	it("releases every expired file across branches in one mint (worst case)", async () => {
		const user = await createTestUser({ storageLimit: 1000 });
		const root = await createTestDirectory(user._id);
		const left = await createTestDirectory(user._id, { parentDirId: root._id });
		const right = await createTestDirectory(user._id, { parentDirId: root._id });

		for (const dir of [left, right, root]) {
			const stale = await initiateUpload(
				dir._id,
				user._id,
				"stale.txt",
				300,
				user.storageLimit,
			);
			await expire(stale.fileId);
		}

		// 900 against a 1000 limit only fits if all three refunds land.
		await initiateUpload(left._id, user._id, "fresh.txt", 900, user.storageLimit);

		expect(await File.countDocuments({ userId: user._id })).toBe(1);
		expect(await dirStats(left._id)).toEqual({ size: 900, fileCount: 1 });
		expect(await dirStats(right._id)).toEqual({ size: 0, fileCount: 0 });
		expect(await dirStats(root._id)).toEqual({ size: 900, fileCount: 1 });
	});

	it("does not delete the object of a reservation confirmed during the sweep", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const body = "raced bytes";

		const raced = await initiateUpload(
			root._id,
			user._id,
			"raced.txt",
			body.length,
			10 ** 9,
		);
		const objectKey = await trackObjectKey(raced.fileId);
		await putObject(objectKey, Readable.from([body]), {
			contentType: raced.contentType,
		});
		await expire(raced.fileId);

		vi.spyOn(File, "deleteOne").mockImplementationOnce(async () => {
			// Only the delete's result is stubbed: in-transaction, a WriteConflict retry hides the deletedCount === 0 branch.
			await confirmUpload(raced.fileId, user._id);
			return { acknowledged: true, deletedCount: 0 };
		});

		await initiateUpload(root._id, user._id, "fresh.txt", 100, 10 ** 9);

		const survivor = await File.findById(raced.fileId)
			.select("+objectKey")
			.lean();
		expect(survivor.status).toBe("ready");
		expect(await objectExists(objectKey)).toBe(true);
		// Skipping the delete must skip the refund too: the bytes back a real file.
		expect(await dirStats(root._id)).toEqual({
			size: body.length + 100,
			fileCount: 2,
		});
	});

	it("keeps the release when the mint is rejected for quota", async () => {
		const user = await createTestUser({ storageLimit: 1000 });
		const root = await createTestDirectory(user._id);
		await upload(root._id, user._id, "kept.txt", "x".repeat(800), user.storageLimit);

		const abandoned = await initiateUpload(
			root._id,
			user._id,
			"stale.txt",
			200,
			user.storageLimit,
		);
		const staleKey = await trackObjectKey(abandoned.fileId);
		await putObject(staleKey, Readable.from(["partial bytes"]), {
			contentType: abandoned.contentType,
		});
		await expire(abandoned.fileId);

		// Rolling the sweep back with the aborted mint would wedge a user who is genuinely full.
		await expect(
			initiateUpload(root._id, user._id, "fresh.txt", 900, user.storageLimit),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED", statusCode: 400 });

		expect(await File.findById(abandoned.fileId)).toBeNull();
		expect(await objectExists(staleKey)).toBe(false);
		expect(await dirStats(root._id)).toEqual({ size: 800, fileCount: 1 });
	});

	it("releases at most MAX_EXPIRED_FILES_PER_SWEEP rows per mint, draining the rest on the next", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const overflow = 5;
		const total = MAX_EXPIRED_FILES_PER_SWEEP + overflow;

		const stale = [];
		for (let i = 0; i < total; i++) {
			const file = await createTestFile(user._id, root._id, {
				name: `stale-${i}.txt`,
				status: "pending",
				size: 10,
			});
			stale.push(file._id);
		}
		await File.updateMany(
			{ _id: { $in: stale } },
			{ uploadExpiresAt: new Date(Date.now() - ONE_MINUTE_MS) },
		);
		await Directory.updateOne(
			{ _id: root._id },
			{ $inc: { size: total * 10, fileCount: total } },
		);

		// Unbounded, a large backlog blows past MongoDB's 60s transaction ceiling.
		await initiateUpload(root._id, user._id, "first.txt", 100, 10 ** 9);

		expect(await File.countDocuments({ _id: { $in: stale } })).toBe(overflow);
		expect(await dirStats(root._id)).toEqual({
			size: overflow * 10 + 100,
			fileCount: overflow + 1,
		});

		await initiateUpload(root._id, user._id, "second.txt", 100, 10 ** 9);

		expect(await File.countDocuments({ _id: { $in: stale } })).toBe(0);
		expect(await dirStats(root._id)).toEqual({ size: 200, fileCount: 2 });
	});
});

describe("uploadFileFromServer releases expired files", () => {
	it("deletes an expired reservation, its object, and its stats before claiming", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const abandoned = await initiateUpload(
			root._id,
			user._id,
			"stale.txt",
			600,
			10 ** 9,
		);
		const staleKey = await trackObjectKey(abandoned.fileId);
		await putObject(staleKey, Readable.from(["partial bytes"]), {
			contentType: abandoned.contentType,
		});
		await expire(abandoned.fileId);

		const file = await upload(root._id, user._id, "imported.txt", "hello"); // 5

		// An import-only account never mints, so its abandoned claims would pile up forever.
		expect(await File.findById(abandoned.fileId)).toBeNull();
		expect(await objectExists(staleKey)).toBe(false);
		expect(file.status).toBe("ready");
		expect(await dirStats(root._id)).toEqual({ size: 5, fileCount: 1 });
	});

	it("leaves a reservation whose window is still open untouched", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const live = await initiateUpload(root._id, user._id, "live.txt", 400, 10 ** 9);

		await upload(root._id, user._id, "imported.txt", "hello"); // 5

		expect(
			(await File.findById(live.fileId).select("+objectKey").lean()).status,
		).toBe("pending");
		expect(await dirStats(root._id)).toEqual({ size: 405, fileCount: 2 });
	});
});

describe("confirmUpload", () => {
	const uploadTo = async (mint, body) => {
		// Tracked before the PUT so a partial write still gets cleaned up.
		await trackObjectKey(mint.fileId);

		const response = await fetch(mint.uploadUrl, {
			method: "PUT",
			headers: {
				"Content-Type": mint.contentType,
				"Content-Length": String(body.length),
			},
			body,
		});
		expect(response.ok).toBe(true);
	};

	it("marks the file ready once the object matches the reservation", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "hello r2 upload";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"notes.txt",
			body.length,
			1_000_000,
		);
		await uploadTo(mint, body);

		const file = await confirmUpload(mint.fileId, user._id);

		expect(file.status).toBe("ready");
		expect(file.size).toBe(body.length);
		expect(file.uploadExpiresAt).toBeUndefined();
	});

	it("does NOT release the reservation when no object was uploaded", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const mint = await initiateUpload(
			root._id,
			user._id,
			"ghost.txt",
			500,
			1_000_000,
		);

		await expect(confirmUpload(mint.fileId, user._id)).rejects.toMatchObject({
			code: "UPLOAD_INCOMPLETE",
		});

		// Invariant 1: the URL is still live, so refunding now would let the
		// bytes land unaccounted.
		expect((await File.findById(mint.fileId).select("+objectKey").lean()).status).toBe("pending");
		expect((await Directory.findById(root._id).lean()).size).toBe(500);
	});

	it("still holds the quota after a failed confirm, so the bypass is closed", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const mint = await initiateUpload(dir._id, user._id, "a.bin", 900, 1000);
		await expect(confirmUpload(mint.fileId, user._id)).rejects.toMatchObject({
			code: "UPLOAD_INCOMPLETE",
		});

		await expect(
			initiateUpload(dir._id, user._id, "b.bin", 900, 1000),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });
	});

	it("rejects an object whose size differs from the reservation", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"drift.txt",
			1000,
			1_000_000,
		);
		const objectKey = await trackObjectKey(mint.fileId);

		// Bypass the signed URL to simulate drift it would normally prevent.
		await putObject(objectKey, Readable.from(["short"]), {
			contentType: mint.contentType,
		});

		await expect(confirmUpload(mint.fileId, user._id)).rejects.toMatchObject({
			code: "UPLOAD_OBJECT_MISMATCH",
		});

		expect((await File.findById(mint.fileId).select("+objectKey").lean()).status).toBe("pending");
	});

	it("rejects an object whose content type differs from the reservation", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "abc";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"typed.txt",
			body.length,
			1_000_000,
		);
		const objectKey = await trackObjectKey(mint.fileId);

		// A server-side copy would preserve the SOURCE object's type and size.
		// Checking the type is what makes that visible.
		await putObject(objectKey, Readable.from([body]), {
			contentType: "application/pdf",
		});

		await expect(confirmUpload(mint.fileId, user._id)).rejects.toMatchObject({
			code: "UPLOAD_OBJECT_MISMATCH",
		});

		expect((await File.findById(mint.fileId).select("+objectKey").lean()).status).toBe("pending");
	});

	it("is idempotent: a second confirm returns the same ready document", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "once";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"once.txt",
			body.length,
			1_000_000,
		);
		await uploadTo(mint, body);
		await confirmUpload(mint.fileId, user._id);

		// A client retrying a confirm whose response was lost uploaded fine;
		// erroring would report a failure that did not happen.
		const again = await confirmUpload(mint.fileId, user._id);
		expect(again.status).toBe("ready");
		expect(again.size).toBe(body.length);
	});

	it("throws UPLOAD_ALREADY_CONFIRMED when a ready file's object no longer matches", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "gone after";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"stale.txt",
			body.length,
			1_000_000,
		);
		await uploadTo(mint, body);
		await confirmUpload(mint.fileId, user._id);

		// Read the key from the document — confirmUpload does not return it.
		const { objectKey } = await File.findById(mint.fileId).select("+objectKey").lean();
		await deleteObject(objectKey);

		await expect(confirmUpload(mint.fileId, user._id)).rejects.toMatchObject({
			code: "UPLOAD_ALREADY_CONFIRMED",
		});
		expect((await File.findById(mint.fileId).select("+objectKey").lean()).status).toBe("ready");
	});

	it("rejects a confirm by a non-owner and leaves the reservation intact", async () => {
		const owner = await createTestUser();
		const attacker = await createTestUser();
		const dir = await createTestDirectory(owner._id);

		const mint = await initiateUpload(
			dir._id,
			owner._id,
			"notes.txt",
			10,
			1_000_000,
		);

		await expect(confirmUpload(mint.fileId, attacker._id)).rejects.toMatchObject(
			{ code: "FILE_NOT_FOUND" },
		);
		expect((await File.findById(mint.fileId).select("+objectKey").lean()).status).toBe("pending");
	});

	it("returns the ready document when a concurrent confirm won first", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "promoted";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"race.txt",
			body.length,
			1_000_000,
		);
		await uploadTo(mint, body);
		await File.updateOne(
			{ _id: mint.fileId },
			{ $set: { status: "ready" }, $unset: { uploadExpiresAt: "" } },
		);

		// The upload succeeded; erroring here would be misleading.
		const file = await confirmUpload(mint.fileId, user._id);
		expect(file.status).toBe("ready");
	});

	// The test above flips the status BEFORE the call, so it returns early and
	// never reaches the compare-and-swap. These two drive that branch directly.
	it("returns the promoted document after losing the compare-and-swap", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "cas promote";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"cas-promote.txt",
			body.length,
			1_000_000,
		);
		await uploadTo(mint, body);

		vi.spyOn(File, "findOneAndUpdate").mockReturnValueOnce({
			lean: async () => {
				// A concurrent confirm promoted the document between our read and the CAS.
				await File.updateOne(
					{ _id: mint.fileId },
					{ $set: { status: "ready" }, $unset: { uploadExpiresAt: "" } },
				);
				return null;
			},
		});

		const file = await confirmUpload(mint.fileId, user._id);

		expect(file.status).toBe("ready");
		expect(String(file._id)).toBe(mint.fileId);
	});

	it("throws FILE_NOT_FOUND when the document was removed instead", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "cas release";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"cas-release.txt",
			body.length,
			1_000_000,
		);
		await uploadTo(mint, body);

		vi.spyOn(File, "findOneAndUpdate").mockReturnValueOnce({
			lean: async () => {
				// The other branch: the document is deleted outright, so
				// re-reading finds nothing and confirm must not resolve null.
				await File.deleteOne({ _id: mint.fileId });
				return null;
			},
		});

		await expect(confirmUpload(mint.fileId, user._id)).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
			statusCode: 404,
		});
	});

	it("compares the object against the STORED content type, not a fresh lookup", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "stored type wins";
		const storedType = "application/x-trove-pinned";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"pinned.txt",
			body.length,
			1_000_000,
		);
		const objectKey = await trackObjectKey(mint.fileId);

		// Stands in for the extension→MIME map moving after the mint: the
		// reservation keeps the type the PUT signature actually pinned.
		await File.updateOne(
			{ _id: mint.fileId },
			{ $set: { contentType: storedType } },
		);
		await putObject(objectKey, Readable.from([body]), {
			contentType: storedType,
		});

		const file = await confirmUpload(mint.fileId, user._id);
		expect(file.status).toBe("ready");
	});

	it("rejects an object matching the extension's MIME but not the stored type", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "recomputed loses";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"pinned.txt",
			body.length,
			1_000_000,
		);
		const objectKey = await trackObjectKey(mint.fileId);

		await File.updateOne(
			{ _id: mint.fileId },
			{ $set: { contentType: "application/x-trove-pinned" } },
		);
		// mimeFromExtension(".txt") — a recomputing confirm would accept this.
		await putObject(objectKey, Readable.from([body]), {
			contentType: "text/plain; charset=utf-8",
		});

		await expect(confirmUpload(mint.fileId, user._id)).rejects.toMatchObject({
			code: "UPLOAD_OBJECT_MISMATCH",
		});
		expect((await File.findById(mint.fileId).select("+objectKey").lean()).status).toBe("pending");
	});
});

describe("objectKey never leaves the service", () => {
	it("updateFile returns the renamed file without the key", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const file = await createTestFile(user._id, dir._id);

		const renamed = await updateFile(file._id, "renamed.txt", user._id);

		expect(renamed.name).toBe("renamed.txt");
		expect(renamed.objectKey).toBeUndefined();
		// Stripped at the return boundary only — the stored key is untouched.
		expect((await File.findById(file._id).select("+objectKey").lean()).objectKey).toBe(
			file.objectKey,
		);
	});

	it("deleteFile returns the deleted file without the key, having read it internally", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const file = await createTestFile(user._id, dir._id);
		await putObjectFor(file);

		const deleted = await deleteFile(file._id, user._id);

		expect(String(deleted._id)).toBe(String(file._id));
		expect(deleted.objectKey).toBeUndefined();
		expect(await File.findById(file._id)).toBeNull();
	});

	it("confirmUpload returns the ready file without the key", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = "no key out";

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"quiet.txt",
			body.length,
			1_000_000,
		);
		await trackObjectKey(mint.fileId);
		const response = await fetch(mint.uploadUrl, {
			method: "PUT",
			headers: {
				"Content-Type": mint.contentType,
				"Content-Length": String(body.length),
			},
			body,
		});
		expect(response.ok).toBe(true);

		const confirmed = await confirmUpload(mint.fileId, user._id);

		expect(confirmed.status).toBe("ready");
		expect(confirmed.objectKey).toBeUndefined();
		// The confirm still matched the object, which needs the stored key.
		expect((await File.findById(mint.fileId).select("+objectKey").lean()).objectKey).toBeTruthy();
	});

	it("initiateUpload never returns the key it just minted", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		const mint = await initiateUpload(dir._id, user._id, "quiet.txt", 10, 1_000_000);
		const { objectKey } = await File.findById(mint.fileId).select("+objectKey").lean();

		expect(mint.objectKey).toBeUndefined();
		// The signed URL necessarily embeds the key; nothing else may expose it.
		expect(JSON.stringify({ ...mint, uploadUrl: undefined })).not.toContain(
			objectKey,
		);
	});
});

describe("quota enforcement fails closed on an unusable limit", () => {
	it("rejects a mint when the limit is undefined, null, or NaN", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		// Any comparison with `undefined` or `NaN` is false, so an absent limit
		// used to disable the quota outright. `req.user` is a lean document, so
		// Mongoose never applies the schema default to it.
		for (const limit of [undefined, null, NaN]) {
			await expect(
				initiateUpload(dir._id, user._id, "x.txt", 100, limit),
			).rejects.toMatchObject({
				code: "STORAGE_LIMIT_EXCEEDED",
				statusCode: 400,
			});
		}

		expect(await File.countDocuments({ userId: user._id })).toBe(0);
		expect(await dirStats(dir._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("rejects a server-side create when the limit is null or NaN", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		for (const limit of [null, NaN]) {
			await expect(
				uploadFileFromServer(
					dir._id,
					user._id,
					"x.txt",
					Readable.from(Buffer.from("bytes")),
					limit,
				),
			).rejects.toMatchObject({
				code: "STORAGE_LIMIT_EXCEEDED",
				statusCode: 400,
			});
		}

		expect(await File.countDocuments({ userId: user._id })).toBe(0);
		expect(await dirStats(dir._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("rejects a non-numeric limit rather than coercing it", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await expect(
			initiateUpload(dir._id, user._id, "x.txt", 100, "1000000"),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });

		expect(await File.countDocuments({ userId: user._id })).toBe(0);
	});

	it("rejects an omitted limit instead of granting an exemption", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		// Exemption is the caller's to declare. A forgotten argument must fail
		// closed, not silently grant unlimited storage.
		await expect(
			uploadFileFromServer(
				dir._id,
				user._id,
				"imported.txt",
				Readable.from(Buffer.from("bytes")),
			),
		).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });

		expect(await dirStats(dir._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("accepts an explicitly declared exemption", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		// How Drive import declares it, until issue #65 lands.
		const file = await uploadFileFromServer(
			dir._id,
			user._id,
			"imported.txt",
			Readable.from(Buffer.from("bytes")),
			Number.POSITIVE_INFINITY,
		);
		createdKeys.add(file.objectKey);

		expect(file.status).toBe("ready");
		expect(await dirStats(dir._id)).toEqual({ size: 5, fileCount: 1 });
	});
});

describe("getFile and createDownloadUrl", () => {
	const readyFile = (user, dir, name = "report.pdf", body = "%PDF-1.4") =>
		upload(dir._id, user._id, name, body);

	it("getFile returns the ready document without the object key", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const created = await readyFile(user, dir);

		const file = await getFile(created._id, user._id);

		expect(file.name).toBe("report.pdf");
		expect(file.status).toBe("ready");
		expect(file.contentType).toBe("application/pdf");
		// The nonce in the key is the only thing making another user's key
		// unguessable, and this response now goes to the client.
		expect(file).not.toHaveProperty("objectKey");
		// The disk path is gone; the read path is R2 only.
		expect(file).not.toHaveProperty("filePath");
	});

	it("getFile hides a pending upload", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const mint = await initiateUpload(dir._id, user._id, "notes.txt", 10, 1_000_000);

		await expect(getFile(mint.fileId, user._id)).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
			statusCode: 404,
		});
	});

	it("createDownloadUrl returns a fetchable inline URL for an allowlisted type", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const created = await readyFile(user, dir);

		const { url, expiresAt } = await createDownloadUrl(created._id, user._id);

		// Invariant 2: the stored key, never one rebuilt from the id.
		expect(decodeURIComponent(url)).toContain(created.objectKey);
		expect(expiresAt).toBeInstanceOf(Date);
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
		expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
			DOWNLOAD_URL_TTL_SECONDS * 1000,
		);

		const response = await fetch(url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(response.headers.get("content-disposition")).toContain("inline");
	});

	it("forces attachment for a type that is not inline-safe", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		// .bin is absent from the MIME map, so it resolves to
		// application/octet-stream, which is not on the inline allowlist.
		const created = await readyFile(user, dir, "blob.bin", "not markup");

		const { url } = await createDownloadUrl(created._id, user._id);
		const response = await fetch(url);

		expect(response.headers.get("content-disposition")).toContain("attachment");
		expect(response.headers.get("content-disposition")).not.toContain("inline");
	});

	it("honours an explicit download request and keeps the file name", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const created = await readyFile(user, dir, "quarterly report.pdf");

		const { url } = await createDownloadUrl(created._id, user._id, {
			download: true,
		});
		const disposition = (await fetch(url)).headers.get("content-disposition");

		expect(disposition).toContain("attachment");
		expect(disposition).toContain("quarterly report.pdf");
	});

	it("serves the stored extension after a rename to another one", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const created = await readyFile(user, dir, "payload.txt", "plain text");

		await updateFile(created._id, "payload.html", user._id);

		const { url } = await createDownloadUrl(created._id, user._id, {
			download: true,
		});
		const response = await fetch(url);
		const disposition = response.headers.get("content-disposition");

		// The extension the browser sees must match the bytes we stored, and the
		// type must stay the one the object was written with.
		expect(disposition).toContain("payload.txt");
		expect(disposition).not.toContain("payload.html");
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	});

	it("refuses a pending upload, a non-owner, and an unknown id", async () => {
		const owner = await createTestUser();
		const attacker = await createTestUser();
		const dir = await createTestDirectory(owner._id);
		const created = await readyFile(owner, dir);
		const mint = await initiateUpload(dir._id, owner._id, "notes.txt", 10, 1_000_000);

		await expect(createDownloadUrl(mint.fileId, owner._id)).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
			statusCode: 404,
		});
		await expect(createDownloadUrl(created._id, attacker._id)).rejects.toMatchObject({
			code: "FILE_NOT_FOUND",
		});
		await expect(
			createDownloadUrl(new mongoose.Types.ObjectId(), owner._id),
		).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
	});
});
