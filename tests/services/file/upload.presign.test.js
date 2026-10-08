import { afterEach, describe, it, expect, vi } from "vitest";

import { initiateUpload } from "../../../src/services/file/upload.service.js";
import { presignPut } from "../../../src/lib/r2.js";
import File from "../../../src/models/file.model.js";

import { createTestUser, createTestDirectory } from "../../factories.js";

vi.mock("../../../src/lib/r2.js", async (importActual) => ({
	...(await importActual()),
	presignPut: vi.fn(),
}));

afterEach(() => {
	vi.restoreAllMocks();
	presignPut.mockReset();
});

describe("initiateUpload presign failure", () => {
	it("warns with the file id and error name only, releases the reservation, rejects FILE_UPLOAD_FAILED", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		presignPut.mockRejectedValueOnce(
			Object.assign(new Error("SECRET-MESSAGE files/leaky-key"), {
				name: "CredentialsProviderError",
			}),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			initiateUpload(dir._id, user._id, "presign.txt", 100, 1_000_000),
		).rejects.toMatchObject({ code: "FILE_UPLOAD_FAILED" });

		expect(warn).toHaveBeenCalledTimes(1);
		const logged = warn.mock.calls.flat().join("\n");
		expect(logged).toMatch(
			/Failed to presign the upload for file [0-9a-f]{24}: CredentialsProviderError/,
		);
		expect(logged).not.toContain("SECRET-MESSAGE");
		expect(logged).not.toContain("files/");
		expect(await File.countDocuments({ userId: user._id })).toBe(0);
	});
});
