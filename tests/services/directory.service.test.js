import { afterEach, describe, it, expect, vi } from "vitest";
import mongoose from "mongoose";
import { Readable } from "node:stream";

import {
	updateAncestorDirectoryStats,
	createDirectory,
	deleteDirectory,
	getDirectory,
	resolveDirectoryNames,
} from "../../src/services/directory.service.js";
import {
	initiateUpload,
	confirmUpload,
} from "../../src/services/file/upload.service.js";
import {
	uploadFileFromServer,
} from "../../src/services/file/serverUpload.service.js";
import { deleteObject, getObjectMetadata } from "../../src/lib/r2.js";
import Directory from "../../src/models/directory.model.js";
import File from "../../src/models/file.model.js";
import {
	createTestUser,
	createTestDirectory,
	createTestFile,
} from "../factories.js";

const statsOf = async (id) => {
	const d = await Directory.findById(id);
	return { size: d.size, fileCount: d.fileCount };
};

const folderCountOf = async (id) => (await Directory.findById(id)).folderCount;

// The limit is always explicit: `uploadFileFromServer` has no default and
// rejects an omitted one, so a test must pass a real quota.
const uploadInto = async (parentId, userId, name, body, storageLimit = 10 ** 9) => {
	const file = await uploadFileFromServer(
		parentId,
		userId,
		name,
		Readable.from(Buffer.from(body)),
		storageLimit,
	);
	return file;
};

// Belt and braces: deleteDirectory removes the objects itself, so this only
// matters when a test checks before the delete. A broken key makes the delete
// fail, which is caught.
const discard = async (file) => {
	try {
		await deleteObject(file.objectKey);
	} catch {}
};

// Objects really land in the dev bucket, and a cascade delete removes the
// document that names the key, so `tests/setup.js` can no longer find it.
const createdKeys = new Set();
const track = (key) => createdKeys.add(key);

afterEach(async () => {
	await Promise.allSettled(
		[...createdKeys].map(async (key) => {
			try {
				await deleteObject(key);
			} catch {}
		}),
	);
	createdKeys.clear();

	vi.restoreAllMocks();
});

describe("updateAncestorDirectoryStats", () => {
	it("increments the start folder and every ancestor up to root", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createTestDirectory(user._id, { parentDirId: root._id });
		const b = await createTestDirectory(user._id, { parentDirId: a._id });

		await updateAncestorDirectoryStats(b._id, { bytes: 100, files: 1 });

		for (const id of [root._id, a._id, b._id]) {
			expect(await statsOf(id)).toEqual({ size: 100, fileCount: 1 });
		}
	});

	it("increments only the root when starting at the root (boundary)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		await updateAncestorDirectoryStats(root._id, { bytes: 7, files: 1 });
		expect(await statsOf(root._id)).toEqual({ size: 7, fileCount: 1 });
	});

	it("does not touch a sibling subtree (isolation)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createTestDirectory(user._id, { parentDirId: root._id });
		const sibling = await createTestDirectory(user._id, { parentDirId: root._id });

		await updateAncestorDirectoryStats(a._id, { bytes: 50, files: 1 });

		expect(await statsOf(sibling._id)).toEqual({ size: 0, fileCount: 0 });
		expect(await statsOf(root._id)).toEqual({ size: 50, fileCount: 1 });
	});

	it("applies negative deltas (decrement)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		await updateAncestorDirectoryStats(root._id, { bytes: 100, files: 2 });
		await updateAncestorDirectoryStats(root._id, { bytes: -40, files: -1 });
		expect(await statsOf(root._id)).toEqual({ size: 60, fileCount: 1 });
	});

	it("updates every level of a deep chain (worst case depth)", async () => {
		const user = await createTestUser();
		let parentDirId = null;
		const dirs = [];
		for (let i = 0; i < 6; i++) {
			const d = await createTestDirectory(user._id, { parentDirId });
			dirs.push(d);
			parentDirId = d._id;
		}

		await updateAncestorDirectoryStats(dirs[5]._id, { bytes: 10, files: 1 });

		for (const d of dirs) {
			expect(await statsOf(d._id)).toEqual({ size: 10, fileCount: 1 });
		}
	});

	it("is a no-op when the start directory does not exist (nullish)", async () => {
		const ghostId = new mongoose.Types.ObjectId();
		await expect(
			updateAncestorDirectoryStats(ghostId, { bytes: 100, files: 1 }),
		).resolves.toBeUndefined();
	});

	it("allows underflow at the Mongoose layer (guard lives in Atlas $jsonSchema)", async () => {
		// $inc bypasses Mongoose validators, so a buggy over-decrement is NOT
		// rejected here. In prod the Atlas `minimum: 0` rejects it. This test
		// pins the known behavior so a future change is conscious.
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		await updateAncestorDirectoryStats(root._id, { bytes: 50, files: 1 });
		await updateAncestorDirectoryStats(root._id, { bytes: -200, files: -5 });
		expect(await statsOf(root._id)).toEqual({ size: -150, fileCount: -4 });
	});

	it("applies a positive folders delta to the start folder and every ancestor", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createTestDirectory(user._id, { parentDirId: root._id });
		const b = await createTestDirectory(user._id, { parentDirId: a._id });

		await updateAncestorDirectoryStats(b._id, { folders: 1 });

		for (const id of [root._id, a._id, b._id]) {
			expect(await folderCountOf(id)).toBe(1);
		}
	});

	it("applies a negative folders delta (decrement)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		await updateAncestorDirectoryStats(root._id, { folders: 2 });
		await updateAncestorDirectoryStats(root._id, { folders: -1 });
		expect(await folderCountOf(root._id)).toBe(1);
	});

	it("applies bytes, files, and folders together", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		await updateAncestorDirectoryStats(root._id, { bytes: 100, files: 2, folders: 3 });
		const d = await Directory.findById(root._id);
		expect({
			size: d.size,
			fileCount: d.fileCount,
			folderCount: d.folderCount,
		}).toEqual({ size: 100, fileCount: 2, folderCount: 3 });
	});

	it("leaves folderCount untouched when folders is omitted (defaults to 0)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		await updateAncestorDirectoryStats(root._id, { folders: 5 });
		await updateAncestorDirectoryStats(root._id, { bytes: 10, files: 1 });
		expect(await folderCountOf(root._id)).toBe(5);
	});
});

describe("deleteDirectory maintains ancestor sizes", () => {
	it("decrements the parent chain by the deleted subtree's totals", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createTestDirectory(user._id, { parentDirId: root._id });
		const file = await uploadInto(a._id, user._id, "f.txt", "12345"); // 5

		expect(await statsOf(root._id)).toEqual({ size: 5, fileCount: 1 });

		await deleteDirectory(a._id, user._id);

		expect(await statsOf(root._id)).toEqual({ size: 0, fileCount: 0 });
		await discard(file);
	});

	it("decrements by the FULL nested subtree, not just direct children (worst case)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createTestDirectory(user._id, { parentDirId: root._id });
		const b = await createTestDirectory(user._id, { parentDirId: a._id });
		const file = await uploadInto(b._id, user._id, "deep.txt", "1234567890"); // 10

		expect(await statsOf(root._id)).toEqual({ size: 10, fileCount: 1 });

		await deleteDirectory(a._id, user._id);

		expect(await statsOf(root._id)).toEqual({ size: 0, fileCount: 0 });
		await discard(file);
	});

	it("leaves a sibling subtree's contribution intact (isolation)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createTestDirectory(user._id, { parentDirId: root._id });
		const sibling = await createTestDirectory(user._id, { parentDirId: root._id });
		const fa = await uploadInto(a._id, user._id, "a.txt", "aaa"); // 3
		const fs = await uploadInto(sibling._id, user._id, "s.txt", "ss"); // 2

		expect(await statsOf(root._id)).toEqual({ size: 5, fileCount: 2 });

		await deleteDirectory(a._id, user._id);

		expect(await statsOf(root._id)).toEqual({ size: 2, fileCount: 1 });
		await discard(fa);
		await discard(fs);
	});

	it("does not change ancestors when deleting an empty folder (boundary)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const empty = await createTestDirectory(user._id, { parentDirId: root._id });

		await deleteDirectory(empty._id, user._id);

		expect(await statsOf(root._id)).toEqual({ size: 0, fileCount: 0 });
	});
});

describe("deleteDirectory maintains ancestor folderCount", () => {
	it("decrements ancestors by the full deleted subtree's folder count", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createDirectory(root._id, "folderA", user._id);
		const b = await createDirectory(a._id, "folderB", user._id);
		await createDirectory(b._id, "folderC", user._id);
		// root.folderCount = 3 (a, b, c)

		await deleteDirectory(a._id, user._id);

		expect(await folderCountOf(root._id)).toBe(0);
	});

	it("decrements the parent by 1 when deleting an empty leaf folder (boundary)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createDirectory(root._id, "folderA", user._id);
		const leaf = await createDirectory(a._id, "leaf", user._id);
		// root = 2 (a, leaf), a = 1 (leaf)

		await deleteDirectory(leaf._id, user._id);

		expect(await folderCountOf(root._id)).toBe(1);
		expect(await folderCountOf(a._id)).toBe(0);
	});

	it("leaves a sibling subtree's count intact (isolation)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createDirectory(root._id, "folderA", user._id);
		const sibling = await createDirectory(root._id, "sibling", user._id);
		await createDirectory(sibling._id, "sChild", user._id);
		await createDirectory(a._id, "aChild", user._id);
		// root = 4 (a, sibling, sChild, aChild)

		await deleteDirectory(a._id, user._id); // removes a + aChild = 2

		expect(await folderCountOf(root._id)).toBe(2); // sibling + sChild
		expect(await folderCountOf(sibling._id)).toBe(1); // sChild
	});
});

describe("getDirectory reads stored sizes", () => {
	it("returns stored totalSize/fileCount for the folder and each child", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const child = await createTestDirectory(user._id, { parentDirId: root._id });
		const file = await uploadInto(child._id, user._id, "f.txt", "123"); // 3

		const data = await getDirectory(root._id, user._id);

		expect(data.totalSize).toBe(3);
		expect(data.fileCount).toBe(1);
		const childView = data.childDirectories.find(
			(d) => String(d.id) === String(child._id),
		);
		expect(childView.totalSize).toBe(3);
		expect(childView.fileCount).toBe(1);

		// Contract: expose totalSize/fileCount only — not the raw stored `size`.
		expect(data.size).toBeUndefined();
		expect(childView.size).toBeUndefined();
	});

	it("reports zeros and an empty child list for an empty folder (boundary)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const data = await getDirectory(root._id, user._id);

		expect(data.totalSize).toBe(0);
		expect(data.fileCount).toBe(0);
		expect(data.childDirectories).toEqual([]);
	});

	it("returns each child's own stored totals (multiple children)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const c1 = await createTestDirectory(user._id, { parentDirId: root._id });
		const c2 = await createTestDirectory(user._id, { parentDirId: root._id });
		const f1 = await uploadInto(c1._id, user._id, "a.txt", "aaaa"); // 4
		const f2 = await uploadInto(c2._id, user._id, "b.txt", "bb"); // 2

		const data = await getDirectory(root._id, user._id);

		const byId = Object.fromEntries(
			data.childDirectories.map((d) => [String(d.id), d.totalSize]),
		);
		expect(byId[String(c1._id)]).toBe(4);
		expect(byId[String(c2._id)]).toBe(2);
		expect(data.totalSize).toBe(6); // root subtree total
	});

	it("returns recursive folderCount for the opened folder and each child", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const child1 = await createDirectory(root._id, "child1", user._id);
		const child2 = await createDirectory(child1._id, "child2", user._id);
		await createDirectory(child2._id, "child3", user._id);

		const data = await getDirectory(root._id, user._id);
		expect(data.folderCount).toBe(3);

		const child1View = data.childDirectories.find(
			(d) => String(d.id) === String(child1._id),
		);
		expect(child1View.folderCount).toBe(2);
	});

	it("reports folderCount 0 for a folder with no sub-folders (boundary)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const data = await getDirectory(root._id, user._id);

		expect(data.folderCount).toBe(0);
	});
});

describe("createDirectory maintains folderCount", () => {
	it("increments the parent's folderCount and starts the new folder at 0", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const child = await createDirectory(root._id, "Documents", user._id);

		expect(await folderCountOf(root._id)).toBe(1);
		expect(await folderCountOf(child._id)).toBe(0);
	});

	it("produces recursive counts down a deep chain (worst case)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const child1 = await createDirectory(root._id, "child1", user._id);
		const child2 = await createDirectory(child1._id, "child2", user._id);
		const child3 = await createDirectory(child2._id, "child3", user._id);

		expect(await folderCountOf(root._id)).toBe(3);
		expect(await folderCountOf(child1._id)).toBe(2);
		expect(await folderCountOf(child2._id)).toBe(1);
		expect(await folderCountOf(child3._id)).toBe(0);
	});

	it("does not affect a sibling subtree (isolation)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const a = await createDirectory(root._id, "folderA", user._id);
		const sibling = await createDirectory(root._id, "sibling", user._id);
		await createDirectory(a._id, "aChild", user._id);

		expect(await folderCountOf(sibling._id)).toBe(0);
		expect(await folderCountOf(root._id)).toBe(3); // a, sibling, aChild
	});
});

describe("createDirectory seeds ancestorIds", () => {
	it("stores a child's ancestorIds as [rootId]", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const child = await createDirectory(root._id, "Documents", user._id);

		const stored = await Directory.findById(child._id).lean();
		expect(stored.ancestorIds.map(String)).toEqual([String(root._id)]);
	});

	it("stores a grandchild's ancestorIds as [rootId, childId]", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const child = await createDirectory(root._id, "Documents", user._id);

		const grandchild = await createDirectory(child._id, "Reports", user._id);

		const stored = await Directory.findById(grandchild._id).lean();
		expect(stored.ancestorIds.map(String)).toEqual([
			String(root._id),
			String(child._id),
		]);
	});

	it("does not expose ancestorIds in the create response", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);

		const child = await createDirectory(root._id, "Documents", user._id);

		expect(child.ancestorIds).toBeUndefined();
	});
});

describe("createTestDirectory factory seeds ancestorIds", () => {
	it("gives a root directory an empty ancestorIds", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		expect(root.ancestorIds.map(String)).toEqual([]);
	});

	it("gives a nested directory its ancestor id chain", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const child = await createTestDirectory(user._id, { parentDirId: root._id });
		const grandchild = await createTestDirectory(user._id, {
			parentDirId: child._id,
		});

		expect(grandchild.ancestorIds.map(String)).toEqual([
			String(root._id),
			String(child._id),
		]);
	});
});

describe("resolveDirectoryNames", () => {
	it("returns an empty array for an empty chain", async () => {
		const user = await createTestUser();
		expect(await resolveDirectoryNames([], user._id)).toEqual([]);
	});

	it("resolves ids to {_id, name} in input order", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, { name: "My Files" });
		const docs = await createTestDirectory(user._id, {
			name: "Documents",
			parentDirId: root._id,
		});

		const result = await resolveDirectoryNames([root._id, docs._id], user._id);

		expect(result.map((r) => r.name)).toEqual(["My Files", "Documents"]);
		expect(result.map((r) => String(r._id))).toEqual([
			String(root._id),
			String(docs._id),
		]);
	});

	it("preserves input order regardless of $in return order", async () => {
		const user = await createTestUser();
		const a = await createTestDirectory(user._id, { name: "Alpha" });
		const b = await createTestDirectory(user._id, { name: "Bravo" });

		const result = await resolveDirectoryNames([b._id, a._id], user._id);

		expect(result.map((r) => r.name)).toEqual(["Bravo", "Alpha"]);
	});

	it("does not resolve a directory owned by another user (ownership scoping)", async () => {
		const owner = await createTestUser();
		const other = await createTestUser();
		const dir = await createTestDirectory(owner._id, { name: "Secret" });

		const result = await resolveDirectoryNames([dir._id], other._id);

		expect(String(result[0]._id)).toBe(String(dir._id));
		expect(result[0].name).toBeUndefined();
	});
});

describe("getDirectory breadcrumb + path", () => {
	it("returns a self-inclusive breadcrumb (root → current) and a path string", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, { name: "My Files" });
		const docs = await createTestDirectory(user._id, {
			name: "Documents",
			parentDirId: root._id,
		});
		const reports = await createTestDirectory(user._id, {
			name: "Reports",
			parentDirId: docs._id,
		});

		const data = await getDirectory(reports._id, user._id);

		expect(data.breadcrumb.map((c) => c.name)).toEqual([
			"My Files",
			"Documents",
			"Reports",
		]);
		expect(data.breadcrumb.map((c) => String(c._id))).toEqual([
			String(root._id),
			String(docs._id),
			String(reports._id),
		]);
		expect(data.path).toBe("/My Files/Documents/Reports");
	});

	it("returns just the folder itself for the root directory", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, { name: "My Files" });

		const data = await getDirectory(root._id, user._id);

		expect(data.breadcrumb.map((c) => c.name)).toEqual(["My Files"]);
		expect(data.path).toBe("/My Files");
	});

	it("does not expose ancestors or raw ancestorIds (top-level or children)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, { name: "My Files" });
		const child = await createTestDirectory(user._id, {
			name: "Documents",
			parentDirId: root._id,
		});

		const data = await getDirectory(root._id, user._id);

		expect(data.ancestors).toBeUndefined();
		expect(data.ancestorIds).toBeUndefined();
		const childView = data.childDirectories.find(
			(d) => String(d.id) === String(child._id),
		);
		expect(childView.ancestorIds).toBeUndefined();
	});
});

describe("getDirectory masks the stored root name", () => {
	// Production stores the root as `root-<email>`; the response must never
	// leak the email or the internal naming convention.
	const LEAKY_ROOT_NAME = "root-leak@example.com";

	it("masks the root name as 'My Files' in name, breadcrumb, and path when viewing the root", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, { name: LEAKY_ROOT_NAME });

		const data = await getDirectory(root._id, user._id);

		expect(data.name).toBe("My Files");
		expect(data.breadcrumb.map((c) => c.name)).toEqual(["My Files"]);
		expect(data.path).toBe("/My Files");

		const serialized = JSON.stringify(data);
		expect(serialized).not.toContain(LEAKY_ROOT_NAME);
		expect(serialized).not.toContain("leak@example.com");
	});

	it("masks only the root crumb in a deep view, preserving descendant names (worst case)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, { name: LEAKY_ROOT_NAME });
		const docs = await createTestDirectory(user._id, {
			name: "Documents",
			parentDirId: root._id,
		});
		const reports = await createTestDirectory(user._id, {
			name: "Reports",
			parentDirId: docs._id,
		});

		const data = await getDirectory(reports._id, user._id);

		expect(data.name).toBe("Reports");
		expect(data.breadcrumb.map((c) => c.name)).toEqual([
			"My Files",
			"Documents",
			"Reports",
		]);
		expect(data.path).toBe("/My Files/Documents/Reports");
		expect(JSON.stringify(data)).not.toContain(LEAKY_ROOT_NAME);
	});

	it("masks the root crumb but not a direct child (boundary: breadcrumb length 2)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id, { name: LEAKY_ROOT_NAME });
		const child = await createTestDirectory(user._id, {
			name: "Documents",
			parentDirId: root._id,
		});

		const data = await getDirectory(child._id, user._id);

		expect(data.name).toBe("Documents");
		expect(data.breadcrumb.map((c) => c.name)).toEqual(["My Files", "Documents"]);
		expect(data.path).toBe("/My Files/Documents");
		expect(JSON.stringify(data)).not.toContain(LEAKY_ROOT_NAME);
	});
});

describe("getDirectory hides the object key", () => {
	it("returns files without objectKey, and never anywhere in the payload", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const child = await createTestDirectory(user._id, { parentDirId: root._id });
		const file = await createTestFile(user._id, root._id);
		await createTestFile(user._id, child._id);

		const data = await getDirectory(root._id, user._id);

		expect(data.files).toHaveLength(1);
		expect(data.files[0].objectKey).toBeUndefined();
		// The nonce in the key is an access control; publishing it erodes it.
		expect(JSON.stringify(data)).not.toContain(file.objectKey);

		// Stripped at the response boundary only — the stored key is intact.
		expect((await File.findById(file._id).select("+objectKey").lean()).objectKey).toBe(
			file.objectKey,
		);
	});

	it("keeps the rest of the file view intact (no over-stripping)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const file = await createTestFile(user._id, root._id, {
			name: "notes.txt",
			size: 42,
		});

		const [view] = (await getDirectory(root._id, user._id)).files;

		expect(String(view.id)).toBe(String(file._id));
		expect(view.name).toBe("notes.txt");
		expect(view.size).toBe(42);
		expect(view.extension).toBe(".txt");
		expect(view.contentType).toBe("text/plain; charset=utf-8");
	});
});

describe("deleteDirectory removes the subtree's stored objects", () => {
	it("removes the R2 object of every file in the subtree", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		// deleteDirectory refuses to delete a root, so the target is a level down.
		const target = await createTestDirectory(user._id, {
			parentDirId: root._id,
		});
		const child = await createTestDirectory(user._id, {
			parentDirId: target._id,
		});

		const a = await uploadInto(target._id, user._id, "a.txt", "aaa");
		const b = await uploadInto(child._id, user._id, "b.txt", "bb");
		track(a.objectKey);
		track(b.objectKey);

		await deleteDirectory(target._id, user._id);

		expect(await getObjectMetadata(a.objectKey)).toBeNull();
		expect(await getObjectMetadata(b.objectKey)).toBeNull();
		expect(await File.countDocuments({ userId: user._id })).toBe(0);
	});

	it("still removes the other objects when one stored key is malformed", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const target = await createTestDirectory(user._id, {
			parentDirId: root._id,
		});

		const good = await uploadInto(target._id, user._id, "good.txt", "ok");
		const bad = await uploadInto(target._id, user._id, "bad.txt", "no");
		track(good.objectKey);
		track(bad.objectKey);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Saved directly to the database so the broken key gets past the usual
		// checks; the folder delete should skip it and still remove the other files.
		const leakyNonce = "a".repeat(32);
		await File.collection.updateOne(
			{ _id: bad._id },
			{ $set: { objectKey: `files/not-an-objectid-${leakyNonce}.txt` } },
		);

		await expect(deleteDirectory(target._id, user._id)).resolves.toBeTruthy();

		expect(await getObjectMetadata(good.objectKey)).toBeNull();

		const logged = warn.mock.calls.flat().join(" ");
		expect(logged).toContain(String(bad._id));
		// The nonce in a key is an access control; it must not reach the logs.
		expect(logged).not.toContain(leakyNonce);
	});
});

describe("deleteDirectory guards live reservations", () => {
	it("refuses while a reservation anywhere in the subtree is live", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const target = await createTestDirectory(user._id, {
			parentDirId: root._id,
		});
		const child = await createTestDirectory(user._id, {
			parentDirId: target._id,
		});

		const mint = await initiateUpload(
			child._id,
			user._id,
			"pending.txt",
			500,
			10 ** 6,
		);

		// Invariant 1: the refund subtracts the whole subtree size, reservations
		// included, so allowing this would refund bytes whose URL is still live.
		await expect(deleteDirectory(target._id, user._id)).rejects.toMatchObject({
			code: "UPLOAD_IN_PROGRESS",
			statusCode: 409,
		});

		expect(await File.findById(mint.fileId)).not.toBeNull();
		expect(await statsOf(root._id)).toEqual({ size: 500, fileCount: 1 });
	});

	it("deletes the subtree once the upload window has closed", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const target = await createTestDirectory(user._id, {
			parentDirId: root._id,
		});

		const mint = await initiateUpload(
			target._id,
			user._id,
			"stale.txt",
			500,
			10 ** 6,
		);
		await File.updateOne(
			{ _id: mint.fileId },
			{ uploadExpiresAt: new Date(Date.now() - 1000) },
		);

		// Past the deadline the presigned URL is dead, so nothing can land in
		// the subtree afterwards. Refusing here would wedge the folder forever:
		// there is no reaper, so the upload never resolves on its own.
		await expect(deleteDirectory(target._id, user._id)).resolves.toBeTruthy();

		expect(await File.findById(mint.fileId)).toBeNull();
		expect(await statsOf(root._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("refuses a mixed subtree without touching the ready file's object", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const target = await createTestDirectory(user._id, {
			parentDirId: root._id,
		});

		const ready = await uploadInto(target._id, user._id, "ready.txt", "abcde");
		track(ready.objectKey);
		await initiateUpload(target._id, user._id, "pending.txt", 500, 10 ** 6);

		await expect(deleteDirectory(target._id, user._id)).rejects.toMatchObject({
			code: "UPLOAD_IN_PROGRESS",
			statusCode: 409,
		});

		expect(await getObjectMetadata(ready.objectKey)).not.toBeNull();
		expect(await File.countDocuments({ userId: user._id })).toBe(2);
	});

	it("succeeds once the pending upload has been cleaned up", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const target = await createTestDirectory(user._id, {
			parentDirId: root._id,
		});

		const mint = await initiateUpload(
			target._id,
			user._id,
			"pending.txt",
			500,
			10 ** 6,
		);
		// No cleanup job on this branch, so stand in for it: drop the expired
		// pending document and refund its bytes. Real cleanup lands in #86.
		await File.deleteOne({ _id: mint.fileId });
		await updateAncestorDirectoryStats(target._id, { bytes: -500, files: -1 });

		await expect(deleteDirectory(target._id, user._id)).resolves.toBeTruthy();
		expect(await statsOf(root._id)).toEqual({ size: 0, fileCount: 0 });
	});

	it("never refunds a live reservation whose bytes still land (quota bypass)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const target = await createTestDirectory(user._id, {
			parentDirId: root._id,
		});
		const body = "unaccounted bytes";

		// 1. Mint a reservation. Its presigned URL cannot be revoked.
		const mint = await initiateUpload(
			target._id,
			user._id,
			"free.bin",
			body.length,
			10 ** 6,
		);
		const { objectKey } = await File.findById(mint.fileId).select("+objectKey").lean();
		track(objectKey);

		// 2. Delete the parent folder — the step that used to refund the bytes.
		await expect(deleteDirectory(target._id, user._id)).rejects.toMatchObject({
			code: "UPLOAD_IN_PROGRESS",
			statusCode: 409,
		});

		// 3. The URL is still live, so the bytes really do land in the bucket.
		const response = await fetch(mint.uploadUrl, {
			method: "PUT",
			headers: {
				"Content-Type": mint.contentType,
				"Content-Length": String(body.length),
			},
			body,
		});
		expect(response.ok).toBe(true);
		expect((await getObjectMetadata(objectKey)).size).toBe(body.length);

		// 4. And they are still charged: the reservation and the folder holding
		// it both survived, so nothing was ever refunded.
		expect(await Directory.findById(target._id)).not.toBeNull();
		expect((await File.findById(mint.fileId).select("+objectKey").lean()).status).toBe("pending");
		expect(await statsOf(root._id)).toEqual({
			size: body.length,
			fileCount: 1,
		});
	});
});

// Deeper than the 21 levels a `$graphLookup` with `maxDepth: 20` can see, and
// `createDirectory` has no depth cap, so a user can reach here at will.
const GRAPH_LOOKUP_BLIND_DEPTH = 23;

// Built through the real service so folderCount stays consistent down the chain.
const buildDeepChain = async (userId, startDirId, levels) => {
	let parentDirId = startDirId;
	const chain = [];

	for (let i = 0; i < levels; i++) {
		const dir = await createDirectory(
			parentDirId,
			`lvl${String(i).padStart(2, "0")}`,
			userId,
		);
		chain.push(dir);
		parentDirId = dir._id;
	}

	return chain;
};

describe("deleteDirectory sees the whole subtree at any depth", () => {
	it("refuses a reservation deeper than the old maxDepth (quota bypass)", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const target = await createTestDirectory(user._id, {
			parentDirId: root._id,
		});
		const chain = await buildDeepChain(
			user._id,
			target._id,
			GRAPH_LOOKUP_BLIND_DEPTH,
		);
		const deepest = chain.at(-1);

		const mint = await initiateUpload(
			deepest._id,
			user._id,
			"free.bin",
			500,
			10 ** 6,
		);

		// The refund subtracts the denormalized root totals, which count files at
		// every depth, so the guard has to see every depth too. Otherwise the
		// bytes are refunded while the presigned URL can still write them.
		await expect(deleteDirectory(target._id, user._id)).rejects.toMatchObject({
			code: "UPLOAD_IN_PROGRESS",
			statusCode: 409,
		});

		expect(await File.findById(mint.fileId)).not.toBeNull();
		expect(await statsOf(root._id)).toEqual({ size: 500, fileCount: 1 });
	});

	it("deletes a file below the old maxDepth, and its object, when the subtree is clean", async () => {
		const user = await createTestUser();
		const root = await createTestDirectory(user._id);
		const target = await createDirectory(root._id, "target", user._id);
		const chain = await buildDeepChain(
			user._id,
			target._id,
			GRAPH_LOOKUP_BLIND_DEPTH,
		);
		const deepest = chain.at(-1);

		const file = await uploadInto(deepest._id, user._id, "deep.txt", "12345");
		track(file.objectKey);

		expect(await statsOf(root._id)).toEqual({ size: 5, fileCount: 1 });

		await deleteDirectory(target._id, user._id);

		expect(await getObjectMetadata(file.objectKey)).toBeNull();
		expect(await File.countDocuments({ userId: user._id })).toBe(0);
		expect(await Directory.countDocuments({ userId: user._id })).toBe(1);
		expect(await statsOf(root._id)).toEqual({ size: 0, fileCount: 0 });
		expect(await folderCountOf(root._id)).toBe(0);
	});
});

describe("getDirectory hides pending uploads", () => {
	it("omits a pending upload and never leaks its lifecycle fields", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await uploadInto(dir._id, user._id, "real.txt", "x");
		await initiateUpload(dir._id, user._id, "pending.txt", 500, 10 ** 6);

		const result = await getDirectory(dir._id, user._id);

		expect(result.files).toHaveLength(1);
		expect(result.files[0].name).toBe("real.txt");

		// Internal upload bookkeeping must never reach a response.
		expect(result.files[0]).not.toHaveProperty("status");
		expect(result.files[0]).not.toHaveProperty("uploadExpiresAt");
		expect(result.files[0]).not.toHaveProperty("objectKey");

		// fileCount is the denormalized quota number and a pending upload really
		// does hold bytes, so it deliberately still counts both.
		expect(result.fileCount).toBe(2);
		expect(result.totalSize).toBe(501);
	});

	it("returns an empty file list when every upload is still pending (boundary)", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);

		await initiateUpload(dir._id, user._id, "one.txt", 100, 10 ** 6);
		await initiateUpload(dir._id, user._id, "two.txt", 200, 10 ** 6);

		const result = await getDirectory(dir._id, user._id);

		expect(result.files).toEqual([]);
		expect(result.fileCount).toBe(2);
	});

	it("shows the file once the upload is confirmed", async () => {
		const user = await createTestUser();
		const dir = await createTestDirectory(user._id);
		const body = Buffer.from("hello");

		const mint = await initiateUpload(
			dir._id,
			user._id,
			"later.txt",
			body.length,
			10 ** 6,
		);
		expect((await getDirectory(dir._id, user._id)).files).toEqual([]);

		await fetch(mint.uploadUrl, {
			method: "PUT",
			body,
			headers: {
				"content-type": mint.contentType,
				"content-length": String(body.length),
			},
		});
		await confirmUpload(mint.fileId, user._id);

		const result = await getDirectory(dir._id, user._id);
		expect(result.files).toHaveLength(1);
		expect(result.files[0].name).toBe("later.txt");
		expect(result.files[0]).not.toHaveProperty("status");
	});
});
