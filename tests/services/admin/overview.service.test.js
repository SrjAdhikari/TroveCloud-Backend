import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";

import { getSystemOverview } from "../../../src/services/admin/overview.service.js";
import { initiateUpload } from "../../../src/services/file/upload.service.js";
import {
	uploadFileFromServer,
} from "../../../src/services/file/serverUpload.service.js";

import { createTestUser, createTestDirectory } from "../../factories.js";

describe("getSystemOverview storage totals", () => {
	it("excludes pending uploads from the platform totals", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await uploadFileFromServer(
			dir._id,
			user._id,
			"real.txt",
			Readable.from(Buffer.from("12345")),
			10 ** 9,
		);
		await initiateUpload(dir._id, user._id, "pending.txt", 9999, 10 ** 9);

		const overview = await getSystemOverview();

		// A pending upload is quota bookkeeping, not a file the platform holds.
		expect(overview.storage.totalBytes).toBe(5);
		expect(overview.storage.totalFiles).toBe(1);
	});

	it("reports zeros when every file is still pending (boundary)", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await initiateUpload(dir._id, user._id, "pending.txt", 4096, 10 ** 9);

		const overview = await getSystemOverview();

		expect(overview.storage.totalBytes).toBe(0);
		expect(overview.storage.totalFiles).toBe(0);
		// The directory the pending upload lives in is still a real directory.
		expect(overview.storage.totalDirectories).toBe(1);
	});
});
