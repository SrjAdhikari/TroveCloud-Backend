import { describe, it, expect } from "vitest";

import {
	FIVE_MINUTES_SECONDS,
	ONE_HOUR_SECONDS,
} from "../../src/utils/date.js";

describe("duration constants", () => {
	it("expresses the presign TTLs in seconds", () => {
		expect(FIVE_MINUTES_SECONDS).toBe(300);
		expect(ONE_HOUR_SECONDS).toBe(3600);
	});
});
