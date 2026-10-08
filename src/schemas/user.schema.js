//* src/schemas/user.schema.js

const userSchema = {
	$jsonSchema: {
		bsonType: "object",
		required: ["_id", "name", "email"],
		properties: {
			_id: {
				bsonType: "objectId",
				description: "_id must be a valid ObjectId",
			},
			name: {
				bsonType: "string",
				maxLength: 100,
				description: "User name must be a string of at most 100 characters",
			},
			email: {
				bsonType: "string",
				maxLength: 254,
				pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
				description: "Email must be a valid email address",
			},
			password: {
				bsonType: "string",
				minLength: 8,
				description: "Password must be at least 8 characters long",
			},
			rootDirId: {
				bsonType: "objectId",
				description: "rootDirId must be a valid ObjectId",
			},
			storageLimit: {
				bsonType: "number",
				description: "Per-user storage quota in bytes",
			},
			profilePicture: {
				bsonType: ["string", "null"],
				description: "Profile picture URL, or null if not yet set",
			},
			profilePictureKey: {
				bsonType: ["string", "null"],
				pattern: "^profile-pictures/[a-f0-9]{24}-[a-f0-9]{32}$",
				description: "R2 object key for a self-hosted profile picture, or null",
			},
			provider: {
				bsonType: "string",
				enum: ["email", "google", "github"],
				description: "Provider must be one of email, google, or github",
			},
			otp: {
				bsonType: "string",
			},
			otpExpiresAt: {
				bsonType: "date",
			},
			isVerified: {
				bsonType: "bool",
			},
			verificationExpiresAt: {
				bsonType: "date",
			},
			role: {
				bsonType: "string",
				enum: ["user", "admin", "superadmin"],
				description:
					"Role must be one of user, admin, or superadmin",
			},
			suspendedAt: {
				bsonType: ["date", "null"],
				description: "Timestamp the user was suspended, or null",
			},
			suspendedBy: {
				bsonType: ["objectId", "null"],
				description:
					"ObjectId of the admin who suspended this user, or null",
			},
			deletedAt: {
				bsonType: ["date", "null"],
				description: "Soft-delete timestamp, or null",
			},
			createdAt: {
				bsonType: "date",
			},
			updatedAt: {
				bsonType: "date",
			},
			__v: {
				bsonType: "int",
			},
		},
		additionalProperties: false,
	},
};

export default userSchema;
