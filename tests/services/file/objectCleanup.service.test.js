import { afterEach, describe, it, expect, vi } from "vitest";

import { removeObjects } from "../../../src/services/file/objectCleanup.service.js";
import {
	deleteObjects,
	MAX_DELETE_KEYS_PER_REQUEST,
} from "../../../src/lib/r2.js";

vi.mock("../../../src/lib/r2.js", async (importActual) => ({
	...(await importActual()),
	deleteObjects: vi.fn(),
}));

const idA = "a".repeat(24);
const idB = "b".repeat(24);
const nonce = "c".repeat(32);
const keyA = `files/${idA}-${nonce}.txt`;
const keyB = `files/${idB}-${nonce}.txt`;

afterEach(() => {
	vi.restoreAllMocks();
	deleteObjects.mockReset();
});

describe("removeObjects", () => {
	it("makes no request for an empty list", async () => {
		await removeObjects([]);

		expect(deleteObjects).not.toHaveBeenCalled();
	});

	it("skips an invalid key with a label-only warn and still sends the valid ones", async () => {
		deleteObjects.mockResolvedValue({ deleted: [keyA], errors: [] });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const badKey = `files/not-an-objectid-${nonce}.txt`;

		await removeObjects([
			{ key: badKey, label: "file bad" },
			{ key: keyA, label: "file a" },
			{ key: undefined, label: "file nullish" },
		]);

		expect(deleteObjects).toHaveBeenCalledWith([keyA]);
		const logged = warn.mock.calls.flat().join("\n");
		expect(logged).toContain("file bad");
		expect(logged).toContain("file nullish");
		expect(logged).not.toContain(nonce);
	});

	it("does not call R2 when every key is invalid", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});

		await removeObjects([{ key: "nope", label: "file x" }]);

		expect(deleteObjects).not.toHaveBeenCalled();
	});

	it("warns per failed entry by label and code, never the key or message", async () => {
		deleteObjects.mockResolvedValue({
			deleted: [keyA],
			errors: [{ key: keyB, code: "AccessDenied", message: `denied ${keyB}` }],
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await removeObjects([
			{ key: keyA, label: "file a" },
			{ key: keyB, label: "file b" },
		]);

		expect(warn).toHaveBeenCalledTimes(1);
		const logged = warn.mock.calls.flat().join("\n");
		expect(logged).toContain("file b");
		expect(logged).toContain("AccessDenied");
		expect(logged).not.toContain(nonce);
		expect(logged).not.toContain("denied");
	});

	it("swallows a thrown batch error with exactly one warn", async () => {
		const failure = Object.assign(new Error(`boom ${keyA}`), {
			name: "ServiceUnavailable",
			$metadata: { httpStatusCode: 503 },
		});
		deleteObjects.mockRejectedValue(failure);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			removeObjects([
				{ key: keyA, label: "file a" },
				{ key: keyB, label: "file b" },
			]),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledTimes(1);
		const logged = warn.mock.calls.flat().join("\n");
		expect(logged).toContain("ServiceUnavailable");
		expect(logged).toContain("503");
		expect(logged).not.toContain(nonce);
	});

	describe("batching", () => {
		const manyItems = (count) =>
			Array.from({ length: count }, (_, i) => {
				const id = i.toString(16).padStart(24, "0");
				return { key: `files/${id}-${nonce}.txt`, label: `file ${i}` };
			});

		it("sends at most MAX_DELETE_KEYS_PER_REQUEST keys per call", async () => {
			deleteObjects.mockResolvedValue({ deleted: [], errors: [] });

			await removeObjects(manyItems(MAX_DELETE_KEYS_PER_REQUEST * 2 + 1));

			expect(deleteObjects).toHaveBeenCalledTimes(3);
			for (const [chunk] of deleteObjects.mock.calls) {
				expect(chunk.length).toBeLessThanOrEqual(MAX_DELETE_KEYS_PER_REQUEST);
			}
		});

		it("keeps deleting later batches when one batch throws", async () => {
			deleteObjects
				.mockRejectedValueOnce(
					Object.assign(new Error("boom"), {
						name: "ServiceUnavailable",
						$metadata: { httpStatusCode: 503 },
					}),
				)
				.mockResolvedValueOnce({ deleted: [], errors: [] });
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			await removeObjects(manyItems(1500));

			expect(deleteObjects).toHaveBeenCalledTimes(2);
			expect(deleteObjects.mock.calls[1][0]).toHaveLength(500);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls.flat().join("\n")).toContain("1000");
		});
	});
});
