import { describe, it, expect, vi } from "vitest";
import mongoose from "mongoose";
import { Readable } from "node:stream";

import {
	updateProfile,
	uploadProfilePicture,
	resolveProfilePictureUrl,
	formatUser,
} from "../../src/services/user.service.js";
import {
	getObjectMetadata,
	PROFILE_PICTURE_URL_TTL_SECONDS,
} from "../../src/lib/r2.js";
import User from "../../src/models/user.model.js";
import envConfig from "../../src/constants/env.js";

import { createTestUser } from "../factories.js";

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(56, 1),
]);
const JPEG = Buffer.concat([
	Buffer.from([0xff, 0xd8, 0xff]),
	Buffer.alloc(61, 1),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const headers = (contentType, body) => ({
	contentType,
	contentLength: String(body.length),
});

describe("user.service.updateProfile", () => {
	it("updates the user's name and persists it", async () => {
		const user = await createTestUser({ name: "Old Name" });

		const result = await updateProfile(user._id, "New Name");

		expect(result.name).toBe("New Name");

		const persisted = await User.findById(user._id).lean();
		expect(persisted.name).toBe("New Name");
	});

	it("returns the user without password, otp, or otpExpiresAt", async () => {
		const user = await createTestUser();

		const result = await updateProfile(user._id, "Visible Name");

		expect(result.password).toBeUndefined();
		expect(result.otp).toBeUndefined();
		expect(result.otpExpiresAt).toBeUndefined();
	});

	it("returns the me-shape fields (id, email, provider, role, timestamps)", async () => {
		const user = await createTestUser();

		const result = await updateProfile(user._id, "Shape Check");

		expect(result._id.toString()).toBe(user._id.toString());
		expect(result.email).toBe(user.email);
		expect(result.provider).toBe("email");
		expect(result.role).toBe("user");
		expect(result.createdAt).toBeDefined();
		expect(result.updatedAt).toBeDefined();
	});

	it("allows an OAuth user to update their name (provider-agnostic)", async () => {
		const user = await createTestUser({ provider: "google" });

		const result = await updateProfile(user._id, "Google Person");

		expect(result.name).toBe("Google Person");
	});

	it("throws USER_NOT_FOUND when the user does not exist", async () => {
		const ghostId = new mongoose.Types.ObjectId();

		await expect(updateProfile(ghostId, "Nobody")).rejects.toMatchObject({
			statusCode: 404,
			code: "USER_NOT_FOUND",
		});
	});
});

describe("user.service.uploadProfilePicture", () => {
	it("writes the object to R2 and points the user at its key", async () => {
		const user = await createTestUser();

		const result = await uploadProfilePicture(
			user._id,
			Readable.from(PNG),
			headers("image/png", PNG),
		);

		expect(result.profilePictureKey).toMatch(
			new RegExp(`^profile-pictures/${user._id}-[a-f0-9]{32}$`),
		);

		const object = await getObjectMetadata(result.profilePictureKey);
		expect(object.size).toBe(PNG.length);

		// The detected type is pinned on the object, which is why it is not
		// also stored on the user.
		expect(object.contentType).toBe("image/png");
	});

	it("caches the object no longer than the signed URL that serves it", async () => {
		const user = await createTestUser();

		const result = await uploadProfilePicture(
			user._id,
			Readable.from(PNG),
			headers("image/png", PNG),
		);

		const response = await fetch(await resolveProfilePictureUrl(result));

		expect(response.headers.get("cache-control")).toBe(
			`private, max-age=${PROFILE_PICTURE_URL_TTL_SECONDS}`,
		);
	});

	it("rejects a declared type outside the allowed set", async () => {
		const user = await createTestUser();

		await expect(
			uploadProfilePicture(
				user._id,
				Readable.from(SVG),
				headers("image/svg+xml", SVG),
			),
		).rejects.toMatchObject({ code: "INVALID_IMAGE_TYPE" });

		await expect(
			uploadProfilePicture(
				user._id,
				Readable.from(SVG),
				headers("application/json", SVG),
			),
		).rejects.toMatchObject({ code: "INVALID_IMAGE_TYPE" });

		expect((await User.findById(user._id).lean()).profilePictureKey).toBeNull();
	});

	it("accepts a declared type in another case or carrying a parameter", async () => {
		const upperCase = await createTestUser();
		const parameterized = await createTestUser();

		const first = await uploadProfilePicture(
			upperCase._id,
			Readable.from(PNG),
			headers("IMAGE/PNG", PNG),
		);
		const second = await uploadProfilePicture(
			parameterized._id,
			Readable.from(PNG),
			headers("image/png; charset=binary", PNG),
		);

		expect(
			(await getObjectMetadata(first.profilePictureKey)).contentType,
		).toBe("image/png");
		expect(
			(await getObjectMetadata(second.profilePictureKey)).contentType,
		).toBe("image/png");
	});

	it("rejects bytes that are not an image, despite an allowed declared type", async () => {
		const user = await createTestUser();
		const body = Buffer.alloc(64, 0x41);

		await expect(
			uploadProfilePicture(
				user._id,
				Readable.from(body),
				headers("image/png", body),
			),
		).rejects.toMatchObject({ code: "INVALID_IMAGE_TYPE" });
	});

	it("rejects bytes that disagree with the declared type", async () => {
		const user = await createTestUser();

		await expect(
			uploadProfilePicture(
				user._id,
				Readable.from(JPEG),
				headers("image/png", JPEG),
			),
		).rejects.toMatchObject({ code: "INVALID_IMAGE_TYPE" });
	});

	it("rejects a declaration over the size limit without reading the body", async () => {
		const user = await createTestUser();

		await expect(
			uploadProfilePicture(user._id, Readable.from(PNG), {
				contentType: "image/png",
				contentLength: String(envConfig.MAX_PROFILE_PICTURE_SIZE + 1),
			}),
		).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
	});

	it("accepts a body sitting exactly on the size limit", async () => {
		const user = await createTestUser();
		const exact = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.alloc(envConfig.MAX_PROFILE_PICTURE_SIZE - 8, 1),
		]);

		// Both limit comparisons are strict, so the cap itself must pass.
		expect(exact.length).toBe(envConfig.MAX_PROFILE_PICTURE_SIZE);

		const result = await uploadProfilePicture(
			user._id,
			Readable.from(exact),
			headers("image/png", exact),
		);

		expect((await getObjectMetadata(result.profilePictureKey)).size).toBe(
			envConfig.MAX_PROFILE_PICTURE_SIZE,
		);
	});

	it("rejects a body that outgrows the limit mid-read", async () => {
		const user = await createTestUser();
		const oversized = Buffer.concat([
			PNG,
			Buffer.alloc(envConfig.MAX_PROFILE_PICTURE_SIZE, 1),
		]);

		await expect(
			uploadProfilePicture(user._id, Readable.from(oversized), {
				contentType: "image/png",
				contentLength: String(PNG.length),
			}),
		).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
	});

	it("rejects a missing or non-numeric Content-Length", async () => {
		const user = await createTestUser();

		await expect(
			uploadProfilePicture(user._id, Readable.from(PNG), {
				contentType: "image/png",
				contentLength: undefined,
			}),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });

		await expect(
			uploadProfilePicture(user._id, Readable.from(PNG), {
				contentType: "image/png",
				contentLength: "not-a-number",
			}),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
	});

	it("rejects a present-but-zero Content-Length without misreporting it as absent", async () => {
		const user = await createTestUser();

		await expect(
			uploadProfilePicture(user._id, Readable.from(PNG), {
				contentType: "image/png",
				contentLength: "0",
			}),
		).rejects.toMatchObject({
			code: "INVALID_INPUT",
			message: "A positive Content-Length is required",
		});
	});

	it("rejects a truncated body, so a clean disconnect cannot be stored", async () => {
		const user = await createTestUser();

		// Issue #48: the stream ends without an error, so only the length
		// comparison catches it.
		await expect(
			uploadProfilePicture(user._id, Readable.from(PNG), {
				contentType: "image/png",
				contentLength: String(PNG.length + 10),
			}),
		).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });

		expect((await User.findById(user._id).lean()).profilePictureKey).toBeNull();
	});

	it("rejects a body that overruns its declared length while staying under the limit", async () => {
		const user = await createTestUser();

		// The other half of the length comparison: over-declared is truncation,
		// under-declared is a body that does not match what was announced.
		await expect(
			uploadProfilePicture(user._id, Readable.from(PNG), {
				contentType: "image/png",
				contentLength: String(PNG.length - 10),
			}),
		).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });

		expect((await User.findById(user._id).lean()).profilePictureKey).toBeNull();
	});

	it("deletes the previous object when the profile picture is replaced", async () => {
		const user = await createTestUser();

		const first = await uploadProfilePicture(
			user._id,
			Readable.from(PNG),
			headers("image/png", PNG),
		);
		const second = await uploadProfilePicture(
			user._id,
			Readable.from(JPEG),
			headers("image/jpeg", JPEG),
		);

		expect(second.profilePictureKey).not.toBe(first.profilePictureKey);
		expect(await getObjectMetadata(first.profilePictureKey)).toBeNull();
		expect(await getObjectMetadata(second.profilePictureKey)).not.toBeNull();
	});

	it("deletes the new object when the pointer write throws", async () => {
		const user = await createTestUser();
		let orphanKey;

		// A rejected query, not a null result: the object is written but nothing
		// will ever point at it.
		const spy = vi
			.spyOn(User, "findByIdAndUpdate")
			.mockImplementation((_id, update) => {
				orphanKey = update.profilePictureKey;

				return {
					select: () => ({
						lean: () => Promise.reject(new Error("write concern timeout")),
					}),
				};
			});

		try {
			await expect(
				uploadProfilePicture(
					user._id,
					Readable.from(PNG),
					headers("image/png", PNG),
				),
			).rejects.toThrow("write concern timeout");
		} finally {
			spy.mockRestore();
		}

		expect(orphanKey).toMatch(
			new RegExp(`^profile-pictures/${user._id}-[a-f0-9]{32}$`),
		);
		expect(await getObjectMetadata(orphanKey)).toBeNull();
	});

	it("leaves an external OAuth profile picture in place alongside the key", async () => {
		const external = "https://lh3.googleusercontent.com/a/abc123";
		const user = await createTestUser({ profilePicture: external });

		const result = await uploadProfilePicture(
			user._id,
			Readable.from(PNG),
			headers("image/png", PNG),
		);

		expect(result.profilePicture).toBe(external);
	});

	it("throws USER_NOT_FOUND for a user that does not exist", async () => {
		await expect(
			uploadProfilePicture(
				new mongoose.Types.ObjectId(),
				Readable.from(PNG),
				headers("image/png", PNG),
			),
		).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
	});
});

describe("user.service.resolveProfilePictureUrl", () => {
	it("signs a GET for the stored key and serves the verified type", async () => {
		const user = await createTestUser();
		const updated = await uploadProfilePicture(
			user._id,
			Readable.from(PNG),
			headers("image/png", PNG),
		);

		const url = await resolveProfilePictureUrl(updated);

		expect(url).toContain("X-Amz-Signature");

		const response = await fetch(url);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
	});

	it("falls back to the external OAuth URL, and prefers the key when both exist", async () => {
		const external = "https://lh3.googleusercontent.com/a/abc123";

		expect(await resolveProfilePictureUrl({ profilePicture: external })).toBe(
			external,
		);

		const user = await createTestUser({ profilePicture: external });
		const updated = await uploadProfilePicture(
			user._id,
			Readable.from(PNG),
			headers("image/png", PNG),
		);

		expect(await resolveProfilePictureUrl(updated)).toContain(
			"X-Amz-Signature",
		);
	});

	it("degrades a malformed stored key to null rather than throwing", async () => {
		const user = await createTestUser();

		// Written through the raw driver: the schema `match` would reject it, so
		// this is the only way such a row can exist — and the only way to test it.
		await User.collection.updateOne(
			{ _id: user._id },
			{ $set: { profilePictureKey: "profile-pictures/not-a-real-key" } },
		);

		const stored = await User.findById(user._id).lean();

		expect(await resolveProfilePictureUrl(stored)).toBeNull();
	});

	it("returns null when the user has no profile picture at all", async () => {
		expect(await resolveProfilePictureUrl({})).toBeNull();
		expect(await resolveProfilePictureUrl(null)).toBeNull();
	});
});

describe("user.service.formatUser", () => {
	it("adds a resolved URL and strips the stored key", async () => {
		const user = await createTestUser();
		const updated = await uploadProfilePicture(
			user._id,
			Readable.from(PNG),
			headers("image/png", PNG),
		);

		const payload = await formatUser(updated);

		expect(payload.profilePictureUrl).toContain("X-Amz-Signature");
		expect(payload).not.toHaveProperty("profilePictureKey");
		expect(payload.name).toBe(updated.name);
	});

	it("yields a null URL for a user with no profile picture", async () => {
		const user = await createTestUser();

		const payload = await formatUser(
			await User.findById(user._id).lean(),
		);

		expect(payload.profilePictureUrl).toBeNull();
		expect(payload).not.toHaveProperty("profilePictureKey");
	});

	it("passes a nullish payload straight through", async () => {
		expect(await formatUser(null)).toBeNull();
		expect(await formatUser(undefined)).toBeUndefined();
	});

	it("keeps one malformed key from failing the whole page", async () => {
		const good = await createTestUser();
		const bad = await createTestUser();

		await uploadProfilePicture(
			good._id,
			Readable.from(PNG),
			headers("image/png", PNG),
		);
		await User.collection.updateOne(
			{ _id: bad._id },
			{ $set: { profilePictureKey: "profile-pictures/not-a-real-key" } },
		);

		// Mirrors how the admin list handler maps a page: one rejection here
		// would take the whole response with it.
		const payloads = await Promise.all(
			[
				await User.findById(good._id).lean(),
				await User.findById(bad._id).lean(),
			].map(formatUser),
		);

		expect(payloads).toHaveLength(2);
		expect(payloads[0].profilePictureUrl).toContain("X-Amz-Signature");
		expect(payloads[1].profilePictureUrl).toBeNull();
	});
});
