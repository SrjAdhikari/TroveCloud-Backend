//* server.js

import app from "./src/app.js";
import envConfig from "./src/constants/env.js";
import connectToMongoDB from "./src/database/mongoDB.js";

const { PORT, NODE_ENV } = envConfig;

const startServer = async () => {
	try {
		await connectToMongoDB();
		console.log("✅ Database connected successfully");

		app.listen(PORT, () => {
			console.log(
				`🚀 Server is running on http://localhost:${PORT} in ${NODE_ENV} environment.`,
			);
		});
	} catch (error) {
		console.error(`❌ Failed to start server: ${error}`);
		process.exit(1);
	}
};

startServer();
