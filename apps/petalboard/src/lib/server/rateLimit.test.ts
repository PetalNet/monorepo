import { describe, expect, it } from "vitest";

import { clientIp, take, trackedKeys } from "./rateLimit";

function ipOf(header: string | null, socket = "127.0.0.1") {
	const headers = new Headers(header ? { "cf-connecting-ip": header } : {});

	return clientIp(new Request("http://localhost/", { headers }), () => socket);
}

describe("clientIp", () => {
	it("keys IPv6 clients by their /64, whatever the spelling", () => {
		expect(
			[
				"2001:db8:abcd:12::1",
				"2001:0db8:abcd:0012:ffff:ffff:ffff:ffff",
				"2001:db8:abcd:12:1:2:3:4",
			].map((ip) => ipOf(ip)),
		).toEqual(Array.from({ length: 3 }, () => "2001:db8:abcd:12::/64"));

		expect(ipOf("2001:db8:abcd:13::1")).toBe("2001:db8:abcd:13::/64");
		expect(ipOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
		expect(ipOf("::1")).toBe("0:0:0:0::/64");
	});

	it("keeps IPv4 addresses whole and unwraps IPv4-mapped sockets", () => {
		expect(ipOf("203.0.113.7")).toBe("203.0.113.7");
		expect(ipOf(null, "::ffff:10.0.0.5")).toBe("10.0.0.5");
	});
});

describe("take", () => {
	it("drops expired windows as time passes, not only when the map is huge", () => {
		const start = 1_000_000_000;

		for (let i = 0; i < 50; i++) {
			take(`sweep-test:${i}`, 1, 1000, start);
		}

		expect(trackedKeys()).toBeGreaterThanOrEqual(50);

		take("sweep-test:later", 1, 1000, start + 2 * 60 * 1000);

		expect(trackedKeys()).toBe(1);
	});
});
