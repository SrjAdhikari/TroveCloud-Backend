//* src/models/user.model.js

import mongoose from "mongoose";
import bcrypt from "bcrypt";

import envConfig from "../constants/env.js";
import { ROLES } from "../constants/roles.js";

const { DEFAULT_STORAGE_LIMIT } = envConfig;
const { Schema, model } = mongoose;

const userSchema = new Schema(
	{
		name: {
			type: String,
			required: true,
			trim: true,
			maxlength: 100,
		},
		email: {
			type: String,
			required: true,
			trim: true,
			lowercase: true,
			match: /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,})+$/,
			unique: true,
		},
		password: {
			type: String,
			required: function () {
				return this.provider === "email";
			},
			minlength: 8,
			select: false,
		},
		rootDirId: {
			type: Schema.Types.ObjectId,
			ref: "Directory",
		},
		storageLimit: {
			type: Number,
			required: true,
			default: DEFAULT_STORAGE_LIMIT,
		},
		profilePicture: {
			type: String,
			default: null,
		},
		profilePictureKey: {
			type: String,
			default: null,
			match: /^profile-pictures\/[a-f0-9]{24}-[a-f0-9]{32}$/,
		},
		provider: {
			type: String,
			enum: ["email", "google", "github"],
			default: "email",
		},
		otp: {
			type: String,
			select: false,
		},
		otpExpiresAt: {
			type: Date,
			select: false,
		},
		isVerified: {
			type: Boolean,
			default: false,
		},
		verificationExpiresAt: {
			type: Date,
			select: false,
		},
		role: {
			type: String,
			enum: Object.values(ROLES),
			default: ROLES.USER,
			index: true,
		},
		suspendedAt: {
			type: Date,
			default: null,
			index: true,
		},
		suspendedBy: {
			type: Schema.Types.ObjectId,
			ref: "User",
			default: null,
		},
		deletedAt: {
			type: Date,
			default: null,
			index: true,
		},
	},
	{
		strict: "throw",
		timestamps: true,
	},
);

userSchema.index({ verificationExpiresAt: 1 }, { expireAfterSeconds: 0 });
userSchema.index(
	{ profilePictureKey: 1 },
	{ partialFilterExpression: { profilePictureKey: { $type: "string" } } },
);

// Encrypt password before saving to database
userSchema.pre("save", async function () {
	if (!this.isModified("password")) return;

	const salt = await bcrypt.genSalt(10);
	this.password = await bcrypt.hash(this.password, salt);
});

// Prevent changing provider after creation.
userSchema.pre("save", async function () {
	if (!this.isNew && this.isDirectModified("provider")) {
		throw new Error("Path `provider` cannot be changed after creation");
	}
});

// Compare incoming user password with hashed password
userSchema.methods.comparePassword = function (userPassword) {
	return bcrypt.compare(userPassword, this.password);
};

const User = model("User", userSchema);
export default User;
