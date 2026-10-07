import { afterEach, describe, expect, it, vi } from "vitest";

import type { Signal } from "./collect";
import { linkabilityHash } from "./collect";
import { buildJumpUrl, compareHashes, readCarriedRef } from "./linkability";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("linkabilityHash", () => {
	it("hashes only available signals explicitly marked for linking, in collection order", () => {
		const signals = [
			{ id: "navigator.language", value: "en-US", linking: true },
			{ id: "network.effectiveType", value: "4g", linking: false },
			{ id: "screen.resolution", value: "(unavailable)", linking: true },
			{ id: "canvas.digest", value: "abc", linking: true },
		] as Signal[];

		expect(linkabilityHash(signals)).toBe("797cc967");
	});
});

describe("cross-context references", () => {
	it("builds an encoded same-origin jump URL and reads it back", () => {
		vi.stubGlobal("window", {
			location: {
				protocol: "https:",
				origin: "https://whoami.example.test",
				host: "whoami.example.test",
				pathname: "/report",
				hash: "",
			},
		});

		expect(buildJumpUrl("a hash/with punctuation")).toBe(
			"https://whoami.example.test/report#ref=a+hash%2Fwith+punctuation&from=whoami.example.test",
		);
		window.location.hash = "#ref=abc123&from=other.example.test";
		expect(readCarriedRef()).toEqual({
			hash: "abc123",
			fromHost: "other.example.test",
			crossContext: true,
		});
	});

	it("treats missing references as absent and distinguishes equal hashes", () => {
		vi.stubGlobal("window", { location: { hash: "", host: "whoami.example.test" } });

		expect(readCarriedRef()).toBeNull();
		expect(compareHashes("same", "same")).toBe("match");
		expect(compareHashes("one", "two")).toBe("differ");
	});
});
