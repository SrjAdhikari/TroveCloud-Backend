import { Readable } from "node:stream";

import mongoose from "mongoose";
import { afterEach, describe, it, expect, vi } from "vitest";

import {
	importFromDrive,
	sanitizeDirName,
	sanitizeFileName,
} from "../../src/services/drive.service.js";

import {
	getDriveFileMetadata,
	downloadDriveFile,
	exportGoogleDoc,
	listDriveFolderChildren,
} from "../../src/lib/googleDrive.js";
import { deleteObject, getObjectMetadata } from "../../src/lib/r2.js";
import File from "../../src/models/file.model.js";
import Directory from "../../src/models/directory.model.js";

import { createTestUser, createTestDirectory } from "../factories.js";

vi.mock("../../src/lib/googleDrive.js", async (importOriginal) => ({
	...(await importOriginal()),
	getDriveFileMetadata: vi.fn(),
	downloadDriveFile: vi.fn(),
	exportGoogleDoc: vi.fn(),
	listDriveFolderChildren: vi.fn(),
}));

// A tiny transfer cap so the cap test needn't stream real volumes; the other tests stay far below it.
const { TEST_DRIVE_IMPORT_CAP } = vi.hoisted(() => ({ TEST_DRIVE_IMPORT_CAP: 64 }));

vi.mock("../../src/constants/env.js", async (importOriginal) => {
	const { default: envConfig } = await importOriginal();
	return {
		default: Object.freeze({
			...envConfig,
			MAX_DRIVE_IMPORT_SIZE: TEST_DRIVE_IMPORT_CAP,
		}),
	};
});

const FOLDER_MIME = "application/vnd.google-apps.folder";

afterEach(() => {
	vi.clearAllMocks();
});

describe("drive sanitizeDirName", () => {
	it("returns an ordinary folder name unchanged", () => {
		expect(sanitizeDirName("Reports")).toBe("Reports");
	});

	it("strips embedded HTML from an imported folder name", () => {
		expect(sanitizeDirName("Reports<script>alert(1)</script>")).toBe("Reports");
	});

	it("strips control characters and path dividers, then trims", () => {
		expect(sanitizeDirName("  a/b\\c\td\n  ")).toBe("abcd");
	});

	it("defaults to 'Imported folder' when empty", () => {
		expect(sanitizeDirName("///")).toBe("Imported folder");
	});

	it("defaults to 'Imported folder' when HTML reduces it to nothing", () => {
		expect(sanitizeDirName("<script>alert(1)</script>")).toBe("Imported folder");
	});

	it("pads a too-short name up to the 3-char minimum", () => {
		expect(sanitizeDirName("ab")).toHaveLength(3);
	});

	it("caps the name at 50 characters", () => {
		expect(sanitizeDirName("a".repeat(80))).toHaveLength(50);
	});
});

describe("drive sanitizeFileName", () => {
	it("returns an ordinary file name unchanged", () => {
		expect(sanitizeFileName("report.pdf")).toBe("report.pdf");
	});

	it("strips embedded HTML from an imported file name", () => {
		expect(sanitizeFileName("report<script>alert(1)</script>.pdf")).toBe(
			"report.pdf",
		);
	});

	it("reduces a traversal path to its base name", () => {
		expect(sanitizeFileName("../../secret.txt")).toBe("secret.txt");
	});

	it("defaults to 'untitled' when empty", () => {
		expect(sanitizeFileName("")).toBe("untitled");
	});

	it("defaults to 'untitled' when HTML reduces it to nothing", () => {
		expect(sanitizeFileName("<script>alert(1)</script>")).toBe("untitled");
	});

	it("appends the fallback extension when missing", () => {
		expect(sanitizeFileName("My Doc", ".pdf")).toBe("My Doc.pdf");
	});

	it("does not double-append an existing extension", () => {
		expect(sanitizeFileName("My Doc.pdf", ".pdf")).toBe("My Doc.pdf");
	});

	it("pads a too-short name up to the 3-char minimum", () => {
		expect(sanitizeFileName("a")).toHaveLength(3);
	});

	it("caps the name at 255 characters", () => {
		expect(sanitizeFileName("a".repeat(300))).toHaveLength(255);
	});

	// Known limitation pinned for awareness — DOMPurify parses a bare "<" as
	// markup, so it eats/encodes legitimate names containing "<". Tracked in
	// issue #60; update these once that fix lands.
	it("mangles a bare '<' (known DOMPurify limitation, see #60)", () => {
		expect(sanitizeFileName("a<b.txt")).toBe("a__"); // extension lost, padded to min 3
		expect(sanitizeFileName("5<10.log")).toBe("5&lt;10.log");
	});
});

describe("drive importFromDrive", () => {
	it("destroys the Drive source stream when the upload rejects before reading it", async () => {
		// Never pushes EOF — a real Drive socket still has bytes in flight, so
		// nothing but an explicit destroy can close it.
		const source = new Readable({ read() {} });
		source.push(Buffer.from("partial drive payload"));
		// Cancelling the web stream destroys this one *with* a reason, so without a
		// listener the rejection surfaces as an unhandled error and kills the worker.
		source.on("error", () => {});

		getDriveFileMetadata.mockResolvedValue({
			id: "drive-readme",
			name: "readme.txt",
			mimeType: "text/plain",
			trashed: false,
		});
		downloadDriveFile.mockResolvedValue({ body: Readable.toWeb(source) });

		const result = await importFromDrive(
			new mongoose.Types.ObjectId().toString(),
			"drive-access-token",
			[{ id: "drive-readme", mimeType: "text/plain" }],
			new mongoose.Types.ObjectId().toString(),
		);

		// Unknown parent — the upload rejects before reading the stream.
		expect(result.imported).toEqual([]);
		expect(result.failed).toEqual([
			{ driveId: "drive-readme", name: "readme.txt", reason: "DIRECTORY_NOT_FOUND" },
		]);
		expect(downloadDriveFile).toHaveBeenCalledTimes(1);

		await vi.waitFor(() => expect(source.destroyed).toBe(true));
	});

	it("rejects unsupported file names without opening a download", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const names = { "d-readme": "README", "d-license": "LICENSE", "d-dot": "trailing." };

		getDriveFileMetadata.mockImplementation(async (_token, id) => ({
			id,
			name: names[id],
			mimeType: "text/plain",
			trashed: false,
		}));
		downloadDriveFile.mockImplementation(async () => ({
			body: Readable.toWeb(Readable.from([Buffer.from("x")])),
		}));

		const result = await importFromDrive(
			user._id.toString(),
			"drive-access-token",
			Object.keys(names).map((id) => ({ id, mimeType: "text/plain" })),
			root._id.toString(),
			user.storageLimit,
		);

		expect(result.imported).toEqual([]);
		expect(result.failed).toEqual(
			Object.entries(names).map(([driveId, name]) => ({
				driveId,
				name,
				reason: "INVALID_INPUT",
			})),
		);
		expect(downloadDriveFile).not.toHaveBeenCalled();
	});

	it("rejects a Google doc whose truncated name loses its export extension, without exporting it", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		// The 255-char cap slices off the ".docx" appended to an over-long name.
		const longName = "a".repeat(300);

		getDriveFileMetadata.mockResolvedValue({
			id: "d-doc",
			name: longName,
			mimeType: "application/vnd.google-apps.document",
			trashed: false,
		});
		exportGoogleDoc.mockResolvedValue({
			body: Readable.toWeb(Readable.from([Buffer.from("x")])),
		});

		const result = await importFromDrive(
			user._id.toString(),
			"drive-access-token",
			[{ id: "d-doc", mimeType: "application/vnd.google-apps.document" }],
			root._id.toString(),
			user.storageLimit,
		);

		expect(result.imported).toEqual([]);
		expect(result.failed).toEqual([
			{ driveId: "d-doc", name: longName, reason: "INVALID_INPUT" },
		]);
		expect(exportGoogleDoc).not.toHaveBeenCalled();
	});

	describe("storage quota", () => {
		// Keys of every claim, captured mid-stream; rejected ones must be gone from R2.
		const claimedKeys = new Map();

		afterEach(async () => {
			await Promise.allSettled(
				[...claimedKeys.values()].map(async (key) => {
					try {
						await deleteObject(key);
					} catch {}
				}),
			);
			claimedKeys.clear();
		});

		// Holds the bytes back until the claim row exists, then records its key.
		const claimCapturingStream = (userId, driveId, name, body) => {
			let observed = false;
			return new Readable({
				read() {
					if (observed) return;
					observed = true;

					vi.waitFor(
						async () => {
							const row = await File.findOne({ userId, name })
								.select("+objectKey")
								.lean();
							if (!row) throw new Error("claim not created yet");
							return row.objectKey;
						},
						{ timeout: 5000, interval: 20 },
					)
						.then((key) => {
							claimedKeys.set(driveId, key);
							this.push(Buffer.from(body));
							this.push(null);
						})
						.catch((err) => this.destroy(err));
				},
			});
		};

		// Fresh streams per call; surviving rows' objects are removed by tests/setup.js.
		const mockDriveFiles = (user, files, folders = []) => {
			const byId = new Map(files.map((f) => [f.id, f]));
			const folderById = new Map(folders.map((f) => [f.id, f]));

			getDriveFileMetadata.mockImplementation(async (_token, id) => ({
				id,
				name: (folderById.get(id) ?? byId.get(id)).name,
				mimeType: folderById.has(id) ? FOLDER_MIME : "text/plain",
				trashed: false,
			}));
			listDriveFolderChildren.mockImplementation(async (_token, folderId) => ({
				files: folderById.get(folderId).children.map((id) => ({
					id,
					name: byId.get(id).name,
					mimeType: "text/plain",
				})),
			}));
			downloadDriveFile.mockImplementation(async (_token, id) => {
				const { name, body } = byId.get(id);
				return {
					body: Readable.toWeb(claimCapturingStream(user._id, id, name, body)),
				};
			});

			return [...folders, ...files.filter((f) => !f.inFolder)].map(
				({ id }) => ({
					id,
					mimeType: folderById.has(id) ? FOLDER_MIME : "text/plain",
				}),
			);
		};

		const importAll = (user, root, items) =>
			importFromDrive(
				user._id,
				"drive-access-token",
				items,
				root._id.toString(),
				user.storageLimit,
			);

		const dirStats = async (dir) => {
			const { size, fileCount } = await Directory.findById(dir._id).lean();
			return { size, fileCount };
		};

		const expectObjectRemoved = async (driveId) => {
			const key = claimedKeys.get(driveId);
			expect(key).toBeDefined();
			expect(await getObjectMetadata(key)).toBeNull();
		};

		it("fails the item that would exceed the quota and keeps the one that fits", async () => {
			const user = await createTestUser({ storageLimit: 10 });
			const root = await createTestDirectory(user._id);
			const items = mockDriveFiles(user, [
				{ id: "d-fits", name: "a.txt", body: "123456" },
				{ id: "d-over", name: "b.txt", body: "12345" },
			]);

			const result = await importAll(user, root, items);

			expect(result.imported.map((i) => i.driveId)).toEqual(["d-fits"]);
			expect(result.failed).toEqual([
				{ driveId: "d-over", name: "b.txt", reason: "STORAGE_LIMIT_EXCEEDED" },
			]);
			expect(await dirStats(root)).toEqual({ size: 6, fileCount: 1 });
			expect(await File.exists({ userId: user._id, name: "b.txt" })).toBeNull();
			await expectObjectRemoved("d-over");
		});

		it("imports a file that exactly fills the quota (boundary)", async () => {
			const user = await createTestUser({ storageLimit: 6 });
			const root = await createTestDirectory(user._id);
			const items = mockDriveFiles(user, [
				{ id: "d-exact", name: "exact.txt", body: "123456" },
			]);

			const result = await importAll(user, root, items);

			expect(result.failed).toEqual([]);
			expect(result.imported.map((i) => i.driveId)).toEqual(["d-exact"]);
			expect(await dirStats(root)).toEqual({ size: 6, fileCount: 1 });
		});

		it("keeps importing smaller items after a quota failure", async () => {
			const user = await createTestUser({ storageLimit: 10 });
			const root = await createTestDirectory(user._id);
			const items = mockDriveFiles(user, [
				{ id: "d-first", name: "first.txt", body: "123456" },
				{ id: "d-big", name: "big.txt", body: "12345" },
				{ id: "d-small", name: "small.txt", body: "1234" },
			]);

			const result = await importAll(user, root, items);

			expect(result.imported.map((i) => i.driveId)).toEqual([
				"d-first",
				"d-small",
			]);
			expect(result.failed).toEqual([
				{ driveId: "d-big", name: "big.txt", reason: "STORAGE_LIMIT_EXCEEDED" },
			]);
			expect(await dirStats(root)).toEqual({ size: 10, fileCount: 2 });
			await expectObjectRemoved("d-big");
		});

		it("fails every item and leaves no file rows when the quota is already full", async () => {
			const user = await createTestUser({ storageLimit: 5 });
			const root = await createTestDirectory(user._id, { size: 5, fileCount: 1 });
			const items = mockDriveFiles(user, [
				{ id: "d-one", name: "one.txt", body: "1" },
				{ id: "d-two", name: "two.txt", body: "22" },
			]);

			const result = await importAll(user, root, items);

			expect(result.imported).toEqual([]);
			expect(result.failed).toEqual([
				{ driveId: "d-one", name: "one.txt", reason: "STORAGE_LIMIT_EXCEEDED" },
				{ driveId: "d-two", name: "two.txt", reason: "STORAGE_LIMIT_EXCEEDED" },
			]);
			expect(await File.countDocuments({ userId: user._id })).toBe(0);
			expect(await dirStats(root)).toEqual({ size: 5, fileCount: 1 });
			await expectObjectRemoved("d-one");
			await expectObjectRemoved("d-two");
		});

		it("fails an over-quota file inside an imported folder and keeps the folder and its fitting sibling", async () => {
			const user = await createTestUser({ storageLimit: 10 });
			const root = await createTestDirectory(user._id);
			const items = mockDriveFiles(
				user,
				[
					{ id: "d-child-fits", name: "fits.txt", body: "123456", inFolder: true },
					{ id: "d-child-over", name: "over.txt", body: "12345", inFolder: true },
				],
				[
					{
						id: "d-folder",
						name: "Reports",
						children: ["d-child-fits", "d-child-over"],
					},
				],
			);

			const result = await importAll(user, root, items);

			expect(result.imported.map((i) => [i.driveId, i.kind])).toEqual([
				["d-folder", "folder"],
				["d-child-fits", "file"],
			]);
			expect(result.failed).toEqual([
				{
					driveId: "d-child-over",
					name: "over.txt",
					reason: "STORAGE_LIMIT_EXCEEDED",
				},
			]);

			const folder = await Directory.findById(result.imported[0].troveId).lean();
			expect(folder.parentDirId.toString()).toBe(root._id.toString());
			expect(await dirStats(folder)).toEqual({ size: 6, fileCount: 1 });
			expect(await dirStats(root)).toEqual({ size: 6, fileCount: 1 });
			expect(await File.exists({ userId: user._id, name: "over.txt" })).toBeNull();
			await expectObjectRemoved("d-child-over");
		});

		describe("transfer cap", () => {
			const fullAccount = async () => {
				const user = await createTestUser({ storageLimit: 5 });
				const root = await createTestDirectory(user._id, { size: 5, fileCount: 1 });
				return { user, root };
			};

			const downloadedIds = () => downloadDriveFile.mock.calls.map(([, id]) => id);

			it("counts bytes of quota-rejected files and stops downloading once the cap is spent", async () => {
				const { user, root } = await fullAccount();
				const items = mockDriveFiles(user, [
					{ id: "d-1", name: "one.txt", body: "a".repeat(30) },
					{ id: "d-2", name: "two.txt", body: "b".repeat(30) },
					{ id: "d-3", name: "three.txt", body: "c".repeat(30) },
					{ id: "d-4", name: "four.txt", body: "d".repeat(30) },
				]);

				const result = await importAll(user, root, items);

				expect(result.imported).toEqual([]);
				expect(result.failed).toEqual([
					{ driveId: "d-1", name: "one.txt", reason: "STORAGE_LIMIT_EXCEEDED" },
					{ driveId: "d-2", name: "two.txt", reason: "STORAGE_LIMIT_EXCEEDED" },
					// 60 of 64 bytes spent: this transfer trips the counter mid-stream.
					{ driveId: "d-3", name: "three.txt", reason: "DRIVE_IMPORT_LIMIT_EXCEEDED" },
					{ driveId: "d-4", name: null, reason: "DRIVE_IMPORT_LIMIT_EXCEEDED" },
				]);
				expect(downloadedIds()).toEqual(["d-1", "d-2", "d-3"]);
				expect(await File.countDocuments({ userId: user._id })).toBe(0);
				expect(await dirStats(root)).toEqual({ size: 5, fileCount: 1 });
				await expectObjectRemoved("d-1");
				await expectObjectRemoved("d-2");
				await expectObjectRemoved("d-3");
			});

			it("fails the rest fast when a quota-rejected transfer lands exactly on the cap", async () => {
				const { user, root } = await fullAccount();
				const half = TEST_DRIVE_IMPORT_CAP / 2;
				const items = mockDriveFiles(user, [
					{ id: "d-1", name: "one.txt", body: "a".repeat(half) },
					{ id: "d-2", name: "two.txt", body: "b".repeat(half) },
					{ id: "d-3", name: "three.txt", body: "c" },
					{ id: "d-4", name: "four.txt", body: "d" },
				]);

				const result = await importAll(user, root, items);

				expect(result.imported).toEqual([]);
				expect(result.failed).toEqual([
					{ driveId: "d-1", name: "one.txt", reason: "STORAGE_LIMIT_EXCEEDED" },
					{ driveId: "d-2", name: "two.txt", reason: "STORAGE_LIMIT_EXCEEDED" },
					{ driveId: "d-3", name: null, reason: "DRIVE_IMPORT_LIMIT_EXCEEDED" },
					{ driveId: "d-4", name: null, reason: "DRIVE_IMPORT_LIMIT_EXCEEDED" },
				]);
				expect(downloadedIds()).toEqual(["d-1", "d-2"]);
				expect(await File.countDocuments({ userId: user._id })).toBe(0);
				await expectObjectRemoved("d-1");
				await expectObjectRemoved("d-2");
			});
		});
	});
});
