//* src/schemas/files.schema.js

const fileSchema = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"_id",
			"extension",
			"name",
			"parentDirId",
			"size",
			"objectKey",
			"userId",
		],
		properties: {
			_id: {
				bsonType: "objectId",
				description: "_id must be a valid ObjectId",
			},
			contentType: {
				bsonType: "string",
				description:
					"Content-Type pinned into the upload signature; written once at creation",
			},
			extension: {
				bsonType: "string",
				pattern: "^[.][a-z0-9]+$",
				description:
					"File extension must be a valid string with leading dot (e.g. '.txt', '.png')",
			},
			name: {
				bsonType: "string",
				description: "File name must be a valid string",
			},
			parentDirId: {
				bsonType: "objectId",
				description:
					"File parentDirId must be a valid ObjectId referencing the parent directory",
			},
			size: {
				bsonType: "number",
				minimum: 0,
				description: "File size in bytes, populated during upload",
			},
			status: {
				bsonType: "string",
				enum: ["pending", "ready"],
				description: "Upload lifecycle state",
			},
			objectKey: {
				bsonType: "string",
				pattern: "^files/[a-f0-9]{24}-[a-f0-9]{32}(\\.[a-z0-9]+)?$",
				description: "Canonical R2 object key; written once at creation",
			},
			uploadExpiresAt: {
				bsonType: "date",
				description: "When the pending upload is given up on; absent once ready",
			},
			cancelledAt: {
				bsonType: "date",
				description:
					"When the client gave the upload up; blocks a late confirm, absent once ready",
			},
			userId: {
				bsonType: "objectId",
				description:
					"userId must be a valid ObjectId referencing the owner user",
			},
			createdAt: {
				bsonType: "date",
			},
			updatedAt: {
				bsonType: "date",
			},
			__v: {
				bsonType: "number",
			},
		},
		additionalProperties: false,
	},
};

export default fileSchema;
