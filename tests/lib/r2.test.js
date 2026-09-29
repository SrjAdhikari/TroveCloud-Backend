import { afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

import envConfig from "../../src/constants/env.js";
import {
	r2Client,
	buildFileKey,
	buildProfilePictureKey,
	presignPut,
	presignGet,
	getObjectMetadata,
	readRange,
	putObject,
	deleteObject,
	deleteObjects,
	listObjects,
} from "../../src/lib/r2.js";

const ID = "507f1f77bcf86cd799439011";
const NONCE = "a".repeat(32);

// Unique per run: two developers sharing the dev bucket must not delete each
// other's fixtures in afterAll.
const RUN = randomUUID().replace(/-/g, "");
const keyFor = (suffix) => `files/${ID}-${RUN}${suffix}`;
const created = new Set();

const put = async (suffix, body, options) => {
	const key = keyFor(suffix);
	created.add(key);
	await putObject(key, Readable.from([body]), options);
	return key;
};

afterAll(async () => {
	await Promise.allSettled(
		[...created].map(async (key) => {
			try { await deleteObject(key); } catch {}
		}),
	);
});

describe("r2 key builders", () => {
	it("builds a file key from id, nonce, and lowercase extension", () => {
		expect(buildFileKey(ID, NONCE, ".pdf")).toBe(`files/${ID}-${NONCE}.pdf`);
		expect(buildFileKey(ID, NONCE, "")).toBe(`files/${ID}-${NONCE}`);
		expect(buildFileKey(ID, NONCE)).toBe(`files/${ID}-${NONCE}`);
	});

	it("rejects an uppercase extension outright", () => {
		// `File.extension` is stored with `lowercase: true`; an uppercase key
		// written at mint could never be matched again.
		expect(() => buildFileKey(ID, NONCE, ".PDF")).toThrow();
	});

	it("rejects malformed ids, nonces, and extensions", () => {
		expect(() => buildFileKey("../../etc/passwd", NONCE, ".pdf")).toThrow();
		expect(() => buildFileKey("", NONCE)).toThrow();
		expect(() => buildFileKey(ID, "short")).toThrow();
		expect(() => buildFileKey(ID, NONCE, "/../evil")).toThrow();
		expect(() => buildFileKey(ID, NONCE, ".tar.gz")).toThrow();
		expect(() => buildFileKey(ID, NONCE, ".c++")).toThrow();
	});

	it("scopes profile picture keys to their owner", () => {
		const token = "b".repeat(32);
		expect(buildProfilePictureKey(ID, token)).toBe(`profile-pictures/${ID}/${token}`);
	});

	it("rejects a malformed owner id or token", () => {
		expect(() => buildProfilePictureKey(ID, "../../etc/passwd")).toThrow();
		expect(() => buildProfilePictureKey(ID, "zz")).toThrow();
		expect(() => buildProfilePictureKey(ID, "A".repeat(32))).toThrow();
		expect(() => buildProfilePictureKey("nope", "b".repeat(32))).toThrow();
	});
});

describe("r2 key validation", () => {
	it("refuses a key that is not one of the two known shapes", async () => {
		// `assertKey` throws synchronously, but these wrappers are async, so the
		// throw surfaces as a rejection rather than a sync throw.
		await expect(getObjectMetadata("../../etc/passwd")).rejects.toMatchObject({ statusCode: 400 });
		await expect(deleteObject("secrets/key.pem")).rejects.toMatchObject({ statusCode: 400 });
		await expect(presignGet("files/not-a-valid-shape.txt")).rejects.toMatchObject({
			statusCode: 400,
		});
		await expect(
			presignPut("profile-pictures/tooshort/abc", { contentType: "text/plain", contentLength: 1 }),
		).rejects.toMatchObject({ statusCode: 400 });
	});
});

describe("r2 object operations", () => {
	it("puts an object and reads it back through a presigned GET", async () => {
		const key = await put(".txt", "hello r2", { contentType: "text/plain" });

		const url = await presignGet(key, { contentType: "text/plain" });
		const response = await fetch(url);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("hello r2");
		expect(response.headers.get("content-type")).toBe("text/plain");
	});

	it("presignGet is stable across calls so the browser cache can hit it", async () => {
		const key = await put(".stable", "cache me");

		const first = await presignGet(key);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const second = await presignGet(key);

		// A per-call signing time would change X-Amz-Date every second, making
		// the URL a fresh cache key on every response.
		expect(second).toBe(first);
		expect((await fetch(second)).status).toBe(200);
	});

	it("presignGet keeps a short-lived URL usable despite quantising", async () => {
		const key = await put(".shortttl", "still valid");

		// The signing window is capped at a quarter of the TTL, so a 60s URL
		// cannot be born already expired.
		const url = await presignGet(key, { ttl: 60 });

		expect((await fetch(url)).status).toBe(200);
	});

	it("getObjectMetadata returns size and content type, or null when absent", async () => {
		const key = await put(".head", "12345", { contentType: "text/plain" });

		expect(await getObjectMetadata(key)).toEqual({ size: 5, contentType: "text/plain" });
		expect(await getObjectMetadata(keyFor(".absent"))).toBeNull();
	});

	it("readRange returns only the requested leading bytes", async () => {
		const key = await put(".range", "ABCDEFGHIJ");
		expect((await readRange(key, 0, 3)).toString()).toBe("ABCD");
	});

	it("presignGet sets an attachment disposition when inline is false", async () => {
		const key = await put(".attach", "bytes");

		const url = await presignGet(key, { fileName: "renamed report.txt", inline: false });
		const disposition = (await fetch(url)).headers.get("content-disposition");

		expect(disposition).toContain("attachment");
		expect(disposition).toContain("renamed report.txt");
	});

	it("presignPut signs both content-length and content-type", async () => {
		const url = await presignPut(keyFor(".signed"), {
			contentType: "text/plain",
			contentLength: 3,
		});

		const signed = decodeURIComponent(
			new URL(url).searchParams.get("X-Amz-SignedHeaders"),
		);
		expect(signed).toContain("content-length");
		expect(signed).toContain("content-type");
	});

	it("presignPut accepts a body matching the signature", async () => {
		const key = keyFor(".exact");
		created.add(key);
		const body = "exactly-24-bytes-long!!!";

		const url = await presignPut(key, { contentType: "text/plain", contentLength: body.length });
		const response = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain", "Content-Length": String(body.length) },
			body,
		});

		expect(response.status).toBe(200);
	});

	it("presignPut rejects a body of a different length or type", async () => {
		const key = keyFor(".mismatch");
		created.add(key);
		const body = "abc";

		const url = await presignPut(key, { contentType: "text/plain", contentLength: body.length });

		const wrongLength = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain" },
			body: "this body is very much longer than three bytes",
		});
		expect(wrongLength.ok).toBe(false);

		const wrongType = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
			body,
		});
		expect(wrongType.ok).toBe(false);

		// A rejection that still wrote the object is the failure the quota
		// model cannot survive, so assert the absence rather than the status.
		expect(await getObjectMetadata(key)).toBeNull();
	});

	it("refuses to mint an upload URL without a signed length or type", async () => {
		// Omitting contentLength does not fail — it drops content-length out of
		// the signature and mints an unbounded upload URL. Omitting contentType
		// fails closed. The asymmetry is why both are checked here.
		await expect(
			presignPut(keyFor(".nolength"), { contentType: "text/plain" }),
		).rejects.toMatchObject({ statusCode: 400 });

		await expect(
			presignPut(keyFor(".notype"), { contentLength: 5 }),
		).rejects.toMatchObject({ statusCode: 400 });

		await expect(
			presignPut(keyFor(".badlength"), { contentType: "text/plain", contentLength: -1 }),
		).rejects.toMatchObject({ statusCode: 400 });

		await expect(
			presignPut(keyFor(".fractional"), { contentType: "text/plain", contentLength: 1.5 }),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("presignGet defaults to attachment disposition", async () => {
		// Callers must opt in to inline after checking isInlineSafe(); user
		// bytes rendered from the R2 origin are the thing being avoided.
		const key = await put(".default", "bytes");

		const disposition = (await fetch(await presignGet(key))).headers.get(
			"content-disposition",
		);
		expect(disposition).toContain("attachment");
	});

	it("deleteObject removes an object and is idempotent", async () => {
		const key = await put(".delete", "bye");

		await deleteObject(key);
		expect(await getObjectMetadata(key)).toBeNull();
		await expect(deleteObject(key)).resolves.toBeUndefined();
	});

	it("listObjects pages through a prefix", async () => {
		await put(".lista", "a");
		await put(".listb", "b");

		const page = await listObjects(`files/${ID}-${RUN}.list`);
		expect(page.keys).toHaveLength(2);
		expect(page.nextToken).toBeUndefined();
		expect(page.keys[0]).toHaveProperty("lastModified");
	});
});

describe("r2 batch delete", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("issues no request when there is nothing to delete", async () => {
		const send = vi.spyOn(r2Client, "send");

		expect(await deleteObjects([])).toEqual({ deleted: [], errors: [] });
		expect(send).not.toHaveBeenCalled();
	});

	it("rejects a nullish key list instead of silently deleting nothing", async () => {
		await expect(deleteObjects()).rejects.toMatchObject({ statusCode: 400 });
		await expect(deleteObjects(null)).rejects.toMatchObject({ statusCode: 400 });
	});

	it("deletes a key and reports it as deleted", async () => {
		const key = await put(".batchone", "one");

		expect(await deleteObjects([key])).toEqual({ deleted: [key], errors: [] });
		expect(await getObjectMetadata(key)).toBeNull();
	});

	it("treats a key that is not in the bucket as deleted, not as an error", async () => {
		const present = await put(".batchpresent", "here");
		const absent = keyFor(".batchabsent");

		const result = await deleteObjects([present, absent]);

		expect(result.errors).toEqual([]);
		expect(result.deleted).toEqual(expect.arrayContaining([present, absent]));
		expect(await getObjectMetadata(present)).toBeNull();
	});

	it("splits a batch larger than the 1000-key S3 limit across commands", async () => {
		const keys = Array.from({ length: 1001 }, (_, index) =>
			buildFileKey(ID, RUN, `.chunk${index}`),
		);

		// Uploading 1001 objects to assert an arithmetic boundary is not worth
		// the bucket traffic, so only the command split is exercised here.
		const send = vi.spyOn(r2Client, "send").mockImplementation(async (command) => ({
			Deleted: command.input.Delete.Objects,
		}));

		const result = await deleteObjects(keys);

		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[0][0].input.Delete.Objects).toHaveLength(1000);
		expect(send.mock.calls[1][0].input.Delete.Objects).toHaveLength(1);
		expect(result.deleted).toEqual(keys);
	});

	it("validates every key before issuing any request", async () => {
		const keys = [
			...Array.from({ length: 1000 }, (_, index) =>
				buildFileKey(ID, RUN, `.guard${index}`),
			),
			"../../etc/passwd",
		];

		const send = vi.spyOn(r2Client, "send").mockResolvedValue({ Deleted: [] });

		// Validating per chunk would delete the first 1000 keys before the
		// malformed one in the second chunk was ever looked at.
		await expect(deleteObjects(keys)).rejects.toMatchObject({ statusCode: 400 });
		expect(send).not.toHaveBeenCalled();
	});

	it("surfaces per-key failures instead of swallowing them", async () => {
		const kept = buildFileKey(ID, RUN, ".batchdenied");
		const gone = buildFileKey(ID, RUN, ".batchok");

		// R2 will not fail a delete on demand, so the Errors[] branch is the one
		// thing here that has to be driven from a stubbed response.
		vi.spyOn(r2Client, "send").mockResolvedValue({
			Deleted: [{ Key: gone }],
			Errors: [{ Key: kept, Code: "AccessDenied", Message: "Access Denied" }],
		});

		// removeObject logs and moves on; a caller of this one must be able to
		// tell which keys the bucket still holds.
		expect(await deleteObjects([gone, kept])).toEqual({
			deleted: [gone],
			errors: [{ key: kept, code: "AccessDenied", message: "Access Denied" }],
		});
	});

	it("reports the requested keys as deleted when the response omits Deleted[]", async () => {
		const keys = [
			buildFileKey(ID, RUN, ".quietone"),
			buildFileKey(ID, RUN, ".quiettwo"),
		];

		// A quiet-mode or shape-shifted response carries no Deleted[]. Reading the
		// deleted set off it reports "0 deleted" while the objects are gone.
		vi.spyOn(r2Client, "send").mockResolvedValue({});

		expect(await deleteObjects(keys)).toEqual({ deleted: keys, errors: [] });
	});

	it("excludes a per-key failure from the deleted set with no Deleted[] to go on", async () => {
		const gone = buildFileKey(ID, RUN, ".quietok");
		const kept = buildFileKey(ID, RUN, ".quietdenied");

		vi.spyOn(r2Client, "send").mockResolvedValue({
			Errors: [{ Key: kept, Code: "AccessDenied", Message: "Access Denied" }],
		});

		expect(await deleteObjects([gone, kept])).toEqual({
			deleted: [gone],
			errors: [{ key: kept, code: "AccessDenied", message: "Access Denied" }],
		});
	});

	it("deletes a duplicated key once and reports it once", async () => {
		const key = buildFileKey(ID, RUN, ".batchdupe");

		const send = vi
			.spyOn(r2Client, "send")
			.mockImplementation(async (command) => ({
				Deleted: command.input.Delete.Objects,
			}));

		// Duplicates otherwise eat the 1000-key chunk budget and inflate `deleted`.
		expect(await deleteObjects([key, key, key])).toEqual({
			deleted: [key],
			errors: [],
		});
		expect(send.mock.calls[0][0].input.Delete.Objects).toEqual([{ Key: key }]);
	});
});

// BLOCKING GATE — the quota model assumes the signed Content-Length bounds the
// stored object size. If either test fails, stop before writing Phase 2.
describe("r2 signed-length is a real bound", () => {
	it("does not permit a chunked upload larger than the signed content length", async () => {
		const key = keyFor(".chunked");
		created.add(key);

		const payload = Buffer.alloc(1_000_000, 0x41);
		// aws-chunked framing: <hex-size>\r\n<data>\r\n0\r\n\r\n
		const framed = Buffer.concat([
			Buffer.from(`${payload.length.toString(16)}\r\n`),
			payload,
			Buffer.from("\r\n0\r\n\r\n"),
		]);

		const url = await presignPut(key, {
			contentType: "application/octet-stream",
			contentLength: framed.length,
		});

		const response = await fetch(url, {
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Length": String(framed.length),
				"Content-Encoding": "aws-chunked",
				"x-amz-decoded-content-length": String(payload.length),
				"x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
			},
			body: framed,
		});

		// Assert on both branches: an `if (response.ok)` alone passes with zero
		// assertions when R2 rejects for an unrelated reason, which is exactly
		// the case this gate must not silently accept.
		const stored = await getObjectMetadata(key);

		if (response.ok) {
			// Never the decoded 1 MB against a signature for the framed length.
			expect(stored.size).toBe(framed.length);
		} else {
			expect(response.status).toBe(403);
			expect(stored).toBeNull();
		}
	});

	it("ignores unsigned x-amz headers that would change PUT semantics", async () => {
		const source = await put(".copysource", "secret bytes");
		const key = keyFor(".copytarget");
		created.add(key);

		const url = await presignPut(key, {
			contentType: "text/plain",
			contentLength: 12,
		});

		const response = await fetch(url, {
			method: "PUT",
			headers: {
				"Content-Type": "text/plain",
				"Content-Length": "12",
				"x-amz-copy-source": `/${envConfig.R2_BUCKET}/${source}`,
				"x-amz-storage-class": "STANDARD_IA",
				"x-amz-tagging": "abuse=true",
			},
			body: "aaaaaaaaaaaa",
		});

		if (response.ok) {
			// Our body must win — not the copy source.
			const check = await fetch(await presignGet(key));
			expect(await check.text()).toBe("aaaaaaaaaaaa");
		} else {
			expect(response.status).toBe(403);
			expect(await getObjectMetadata(key)).toBeNull();
		}
	});
});
