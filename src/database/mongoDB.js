//* src/database/mongoDB.js

import { constants } from "node:os";
import mongoose from "mongoose";
import envConfig from "../constants/env.js";

const { MONGODB_URI } = envConfig;

// Connect to MongoDB database
const connectToMongoDB = async () => {
	try {
		console.log("🔄️ Connecting to MongoDB...");
		await mongoose.connect(MONGODB_URI);
	} catch (error) {
		console.error(`❌ MongoDB connection failed: ${error.message}`);
		process.exit(1);
	}
};

// Graceful shutdown: exit code is 128 plus the stop signal's number (130 for
// Ctrl+C, 143 for a shutdown request), so a stopped run never looks successful
const gracefulShutdown = async (signal) => {
	await mongoose.disconnect();
	console.log("👋️ MongoDB connection closed");
	process.exit(128 + constants.signals[signal]);
};

// Handle SIGINT (Ctrl+C) and SIGTERM (cloud providers stop)
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

export { gracefulShutdown };
export default connectToMongoDB;
