import { deleteObject } from "../../src/lib/r2.js";
import File from "../../src/models/file.model.js";
import User from "../../src/models/user.model.js";

/** Deletes the R2 object of every file and profile picture still in the database. */
export const cleanupTestObjects = async () => {
	const [files, users] = await Promise.all([
		File.find().select("objectKey").lean(),
		User.find({ profilePictureKey: { $ne: null } })
			.select("profilePictureKey")
			.lean(),
	]);

	const keys = [
		...files.map((file) => file.objectKey),
		...users.map((user) => user.profilePictureKey),
	];

	await Promise.allSettled(
		keys.map(async (key) => {
			// A broken key makes the delete fail; ignore it, this is only cleanup.
			try {
				await deleteObject(key);
			} catch {}
		}),
	);
};
