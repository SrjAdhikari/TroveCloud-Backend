import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";

import { getStorageUsage } from "../../src/services/storage.service.js";
import { putObject } from "../../src/lib/r2.js";
import File from "../../src/models/file.model.js";
import Directory from "../../src/models/directory.model.js";
import { ONE_MINUTE_MS } from "../../src/utils/date.js";

import {
	createTestUser,
	createTestDirectory,
	createTestFile,
} from "../factories.js";

const expire = async (fileId) =>
	File.updateOne(
		{ _id: fileId },
		{ uploadExpiresAt: new Date(Date.now() - ONE_MINUTE_MS) },
	);

describe("getStorageUsage", () => {
	it("returns zero usage and the default quota for a user with no files", async () => {
		const user = await createTestUser();

		const usage = await getStorageUsage(user._id, user.storageLimit);

		expect(usage).toEqual({
			used: 0,
			total: user.storageLimit,
			breakdown: [],
		});
	});

	it("reports `used` from the root directory size with a category breakdown sorted desc", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, {
			size: 1600,
			fileCount: 4,
		});
		await createTestFile(user._id, root._id, { extension: ".pdf", size: 1000 });
		await createTestFile(user._id, root._id, { extension: ".jpg", size: 400 });
		await createTestFile(user._id, root._id, { extension: ".png", size: 100 });
		await createTestFile(user._id, root._id, { extension: ".bin", size: 100 });

		const usage = await getStorageUsage(user._id, user.storageLimit);

		expect(usage.used).toBe(1600);
		expect(usage.total).toBe(user.storageLimit);
		expect(usage.breakdown).toEqual([
			{ category: "Documents", size: 1000, icon: "file-text" },
			{ category: "Images", size: 500, icon: "image" },
			{ category: "Other", size: 100, icon: "file" },
		]);
	});

	it("leaves pending uploads out of the breakdown", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, {
			size: 1500,
			fileCount: 2,
		});
		await createTestFile(user._id, root._id, {
			extension: ".pdf",
			size: 1000,
		});

		// Its bytes are already inside root.size because the quota is reserved up
		// front, but it is not a file the user has, so it must not appear as one.
		await createTestFile(user._id, root._id, {
			extension: ".jpg",
			size: 500,
			status: "pending",
		});

		const usage = await getStorageUsage(user._id, user.storageLimit);

		expect(usage.used).toBe(1500);
		expect(usage.breakdown).toEqual([
			{ category: "Documents", size: 1000, icon: "file-text" },
		]);
	});

	it("counts only the requesting user's files and root (cross-user isolation)", async () => {
		const me = await createTestUser();
		const other = await createTestUser();
		const myRoot = await createTestDirectory(me._id, {
			size: 300,
			fileCount: 1,
		});
		const otherRoot = await createTestDirectory(other._id, {
			size: 9999,
			fileCount: 1,
		});
		await createTestFile(me._id, myRoot._id, { extension: ".pdf", size: 300 });
		await createTestFile(other._id, otherRoot._id, {
			extension: ".pdf",
			size: 9999,
		});

		const usage = await getStorageUsage(me._id, me.storageLimit);

		expect(usage.used).toBe(300);
		expect(usage.breakdown).toEqual([
			{ category: "Documents", size: 300, icon: "file-text" },
		]);
	});

	it("surfaces a category for a 0-byte file (size 0, boundary)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, { size: 0, fileCount: 1 });
		await createTestFile(user._id, root._id, { extension: ".txt", size: 0 });

		const usage = await getStorageUsage(user._id, user.storageLimit);

		expect(usage.breakdown).toEqual([
			{ category: "Documents", size: 0, icon: "file-text" },
		]);
	});

	it("reports a custom per-user quota", async () => {
		const user = await createTestUser({ storageLimit: 5000 });

		const usage = await getStorageUsage(user._id, user.storageLimit);

		expect(usage.total).toBe(5000);
	});

	it("refunds an expired reservation with no object before reading `used`", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, {
			size: 1500,
			fileCount: 2,
		});
		await createTestFile(user._id, root._id, { extension: ".pdf", size: 1000 });
		const lapsed = await createTestFile(user._id, root._id, {
			extension: ".jpg",
			size: 500,
			status: "pending",
		});
		await expire(lapsed._id);

		const usage = await getStorageUsage(user._id, user.storageLimit);

		expect(usage.used).toBe(1000);
		expect(await File.exists({ _id: lapsed._id })).toBeNull();
		expect((await Directory.findById(root._id)).fileCount).toBe(1);
	});

	it("promotes an expired reservation whose object landed before reading the breakdown", async () => {
		const user = await createTestUser();
		const body = "landed bytes"; // 12
		const root = await createTestDirectory(user._id, {
			size: body.length,
			fileCount: 1,
		});
		const landed = await createTestFile(user._id, root._id, {
			extension: ".jpg",
			size: body.length,
			status: "pending",
		});
		await putObject(landed.objectKey, Readable.from([body]), {
			contentType: landed.contentType,
		});
		await expire(landed._id);

		const usage = await getStorageUsage(user._id, user.storageLimit);

		// Its bytes were counted at mint, so promotion leaves `used` alone.
		expect(usage.used).toBe(body.length);
		expect((await File.findById(landed._id).lean()).status).toBe("ready");
		expect(usage.breakdown).toEqual([
			{ category: "Images", size: body.length, icon: "image" },
		]);
	});

	it("keeps counting a reservation that has not expired yet", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, {
			size: 500,
			fileCount: 1,
		});
		const live = await createTestFile(user._id, root._id, {
			extension: ".jpg",
			size: 500,
			status: "pending",
		});
		const uploadExpiresAt = new Date(Date.now() + ONE_MINUTE_MS);
		await File.updateOne({ _id: live._id }, { uploadExpiresAt });

		const usage = await getStorageUsage(user._id, user.storageLimit);

		expect(usage.used).toBe(500);
		const row = await File.findById(live._id).lean();
		expect(row.status).toBe("pending");
		expect(row.uploadExpiresAt.getTime()).toBe(uploadExpiresAt.getTime());
	});
});
