import { describe, it, expect, afterEach, vi } from "vitest";
import mongoose from "mongoose";

import { gracefulShutdown } from "../../src/database/mongoDB.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("gracefulShutdown", () => {
	it("exits 130 on SIGINT and 143 on SIGTERM after disconnecting", async () => {
		const order = [];
		vi.spyOn(mongoose, "disconnect").mockImplementation(async () => {
			order.push("disconnect");
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			order.push(`exit:${code}`);
		});

		await gracefulShutdown("SIGINT");
		await gracefulShutdown("SIGTERM");

		expect(order).toEqual([
			"disconnect",
			"exit:130",
			"disconnect",
			"exit:143",
		]);
		expect(exit).toHaveBeenNthCalledWith(1, 130);
		expect(exit).toHaveBeenNthCalledWith(2, 143);
	});
});
