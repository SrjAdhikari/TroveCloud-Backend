//* src/models/file.model.js

import mongoose from "mongoose";

const { Schema, model } = mongoose;
const fileSchema = new Schema(
	{
		name: {
			type: String,
			required: true,
			trim: true,
			minlength: 3,
		},
		extension: {
			type: String,
			required: true,
			trim: true,
			lowercase: true,
			match: /^\.[a-z0-9]+$/,
		},
		contentType: {
			type: String,
			required: true,
			trim: true,
		},
		size: {
			type: Number,
			required: true,
			min: 0,
		},
		parentDirId: {
			type: Schema.Types.ObjectId,
			ref: "Directory",
			required: true,
		},
		userId: {
			type: Schema.Types.ObjectId,
			ref: "User",
			required: true,
		},
		status: {
			type: String,
			enum: ["pending", "ready"],
			default: "ready",
			required: true,
		},
		uploadExpiresAt: {
			type: Date,
		},
		objectKey: {
			type: String,
			required: true,
			unique: true,
			select: false,
			match: /^files\/[a-f0-9]{24}-[a-f0-9]{32}(\.[a-z0-9]+)?$/,
		},
	},
	{
		strict: "throw",
		timestamps: true,
	},
);

fileSchema.index({ parentDirId: 1, userId: 1 });
fileSchema.index({ userId: 1, status: 1, uploadExpiresAt: 1 });

const File = model("File", fileSchema);
export default File;
