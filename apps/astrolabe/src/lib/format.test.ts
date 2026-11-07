import { describe, expect, it } from "vitest";

import { formatDuration } from "./format.js";

const minutes = (value: number) => value * 60_000;

describe("formatDuration", () => {
	it.each([
		[minutes(0), "0m"],
		[minutes(12), "12m"],
		[minutes(59), "59m"],
		[minutes(60), "1h 0m"],
		[minutes(3 * 60 + 12), "3h 12m"],
		[minutes(23 * 60 + 59), "23h 59m"],
		[minutes(24 * 60), "1d 0h"],
		[minutes(135 * 60 + 21), "5d 15h"],
	])("formats %d ms as %s", (value, expected) => {
		expect(formatDuration(value)).toBe(expected);
	});

	it("never rounds a countdown up", () => {
		expect(formatDuration(minutes(60) - 1)).toBe("59m");
	});

	it("reads an expired countdown as zero", () => {
		expect(formatDuration(-minutes(5))).toBe("0m");
	});
});
