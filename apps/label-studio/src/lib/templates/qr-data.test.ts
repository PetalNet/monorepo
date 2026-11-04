import { describe, expect, it } from "vitest";

import { escapeQrValue, meCard, wifiJoin } from "./qr-data.ts";

describe("escapeQrValue", () => {
	it("backslash-escapes every separator the formats reserve", () => {
		expect(escapeQrValue(String.raw`a;b,c:d"e\f`)).toBe(String.raw`a\;b\,c\:d\"e\\f`);
	});

	it("leaves ordinary text alone", () => {
		expect(escapeQrValue("Guest network 5G")).toBe("Guest network 5G");
	});
});

describe("wifiJoin", () => {
	it("builds a WPA join payload", () => {
		expect(wifiJoin("Home", "hunter2")).toBe("WIFI:T:WPA;S:Home;P:hunter2;;");
	});

	it("escapes a password that would otherwise end the field early", () => {
		expect(wifiJoin("Home", "a;b")).toBe(String.raw`WIFI:T:WPA;S:Home;P:a\;b;;`);
	});

	it("omits the password for an open network", () => {
		expect(wifiJoin("Cafe", "ignored", "nopass")).toBe("WIFI:T:nopass;S:Cafe;;");
	});
});

describe("meCard", () => {
	it("builds a MECARD with escaped values", () => {
		expect(meCard({ name: "Ex: Ample", phone: "+1 555 0100", email: "a@example.com" })).toBe(
			String.raw`MECARD:N:Ex\: Ample;TEL:+1 555 0100;EMAIL:a@example.com;;`,
		);
	});
});
