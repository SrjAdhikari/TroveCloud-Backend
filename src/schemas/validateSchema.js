//* src/schemas/validateSchema.js

import mongoose from "mongoose";
import connectToMongoDB from "../database/mongoDB.js";

import directorySchema from "./directories.schema.js";
import fileSchema from "./files.schema.js";
import userSchema from "./user.schema.js";

const collections = [
	{ name: "directories", schema: directorySchema },
	{ name: "files", schema: fileSchema },
	{ name: "users", schema: userSchema },
];

// Creates any missing collections and adds the database validation rules to each one.
const validateSchema = async () => {
	try {
		await connectToMongoDB();

		const db = mongoose.connection.db;
		const collectionList = await db.listCollections().toArray();
		const existingCollections = collectionList.map(
			(collection) => collection.name,
		);

		for (const { name, schema } of collections) {
			try {
				if (!existingCollections.includes(name)) {
					await db.createCollection(name);
				}

				await db.command({
					collMod: name,
					validator: schema,
					validationLevel: "strict",
					validationAction: "error",
				});
				console.log(`✅ Validation added to ${name} collection`);
			} catch (error) {
				console.error(
					`❌ Validation failed for ${name} collection: ${error.message}`,
				);
			}
		}
	} catch (error) {
		console.error(`❌ Error [validateSchema]: ${error.message}`);
	} finally {
		await mongoose.disconnect();
		console.log("👋️ MongoDB connection closed");
		process.exit(0);
	}
};

validateSchema();
