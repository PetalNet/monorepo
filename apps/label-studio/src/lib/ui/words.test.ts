import { describe, expect, it } from "vitest";

import { formatMm, plainError, relativeTime } from "./words";

describe("plainError", () => {
	it("turns daemon phrases into a recovery step", () => {
		expect(plainError("cover open")).toBe("Cover open. Close it and retry.");
		expect(plainError("wrong tape: designed for 9 mm, 12 mm loaded")).toMatch(/^Wrong tape loaded/);
	});

	it("passes unknown messages through", () => {
		expect(plainError("printer not found on USB")).toBe(
			"Printer offline. Check it is on and connected.",
		);

		expect(plainError("Printer not connected")).toBe(
			"Printer offline. Check it is on and connected.",
		);

		expect(plainError("Template not found: pantry")).toBe("Template not found: pantry");
		expect(plainError("Something new")).toBe("Something new");
	});
});

describe("formatting", () => {
	it("formats tape lengths", () => {
		expect(formatMm(42.04)).toBe("42.0");
		expect(formatMm(312.6)).toBe("313");
	});

	it("says how long ago", () => {
		const now = Date.parse("2026-01-02T12:00:00Z");

		expect(relativeTime("2026-01-02T11:57:00Z", now)).toBe("3 minutes ago");
		expect(relativeTime("2026-01-01T12:00:00Z", now)).toBe("yesterday");
	});
});
