import { describe, expect, it } from "vitest";

import { escapeQrValue } from "./qr-data.ts";

describe("escapeQrValue", () => {
	it("backslash-escapes every separator the formats reserve", () => {
		expect(escapeQrValue(String.raw`a;b,c:d"e\f`)).toBe(String.raw`a\;b\,c\:d\"e\\f`);
	});

	it("leaves ordinary text alone", () => {
		expect(escapeQrValue("Guest network 5G")).toBe("Guest network 5G");
	});
});
