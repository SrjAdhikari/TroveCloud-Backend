import { describe, it, expect } from "vitest";

import File from "../../src/models/file.model.js";
import { createTestUser, createTestDirectory } from "../factories.js";

const ID_HEX = () => "507f1f77bcf86cd7994390" + Math.floor(10 + Math.random() * 89);

const baseFile = async (overrides = {}) => {
	const user = await createTestUser();
	const dir = await createTestDirectory(user._id);
	return {
		name: "notes.txt",
		extension: ".txt",
		contentType: "text/plain; charset=utf-8",
		size: 10,
		parentDirId: dir._id,
		userId: user._id,
		objectKey: `files/${ID_HEX()}-${"a".repeat(32)}.txt`,
		...overrides,
	};
};

describe("File.status", () => {
	it("defaults to ready", async () => {
		expect((await File.create(await baseFile())).status).toBe("ready");
	});

	it("accepts pending and rejects anything else", async () => {
		expect((await File.create(await baseFile({ status: "pending" }))).status).toBe("pending");
		await expect(File.create(await baseFile({ status: "halfway" }))).rejects.toThrow();
	});
});

describe("File.uploadExpiresAt", () => {
	it("stores a reservation deadline and is absent on a ready file", async () => {
		const at = new Date(Date.now() + 60_000);
		const pending = await File.create(
			await baseFile({ status: "pending", uploadExpiresAt: at }),
		);
		expect(pending.uploadExpiresAt.getTime()).toBe(at.getTime());
		expect((await File.create(await baseFile())).uploadExpiresAt).toBeUndefined();
	});
});

describe("File.objectKey", () => {
	it("is required", async () => {
		const doc = await baseFile();
		delete doc.objectKey;
		await expect(File.create(doc)).rejects.toThrow();
	});

	it("rejects a key outside the files prefix", async () => {
		await expect(
			File.create(await baseFile({ objectKey: `profile-pictures/${ID_HEX()}-${"a".repeat(32)}` })),
		).rejects.toThrow();
		await expect(
			File.create(await baseFile({ objectKey: "files/no-nonce.txt" })),
		).rejects.toThrow();
	});

	it("is unique", async () => {
		await File.syncIndexes();
		const first = await baseFile();
		await File.create(first);
		const second = await baseFile({ objectKey: first.objectKey });
		await expect(File.create(second)).rejects.toThrow();
	});
});

describe("File.extension", () => {
	it("lowercases what it stores, which is why keys are stored and not rebuilt", async () => {
		const file = await File.create(await baseFile({ extension: ".PDF" }));
		expect(file.extension).toBe(".pdf");
	});
});
