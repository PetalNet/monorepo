import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/episodes/redact.ts";
import { candidateSpans, matchKnownSecrets } from "../src/episodes/secrets.ts";

describe("incremental known-secret matching", () => {
	it("matches every reference candidate including delimiter endpoints and multiple runs", () => {
		for (const delimiter of [".", "-", "/", "+", "../", "--"]) {
			const text = `prefix${delimiter}${"A".repeat(16)}${delimiter}${"B".repeat(18)}${delimiter}suffix ${"C".repeat(15)}`;
			const reference = candidateSpans(text);

			expect(reference.truncated).toBe(false);

			for (const value of new Set(reference.spans)) {
				const result = matchKnownSecrets(text, new Set([sha256Hex(value)]));

				expect(result).toEqual({ spans: [value], truncated: false });
			}

			expect(matchKnownSecrets(text, new Set([sha256Hex("absent")])).spans).toEqual([]);
		}
	});

	it("retains the exact reference limit even when an earlier run matched", () => {
		for (let delimiters = 20; delimiters <= 26; delimiters++) {
			const value = "A".repeat(16);
			const text = `${value} ${Array.from({ length: delimiters + 1 }, () => value).join("-")}`;
			const reference = candidateSpans(text);
			const result = matchKnownSecrets(text, new Set([sha256Hex(value)]));

			expect(result.truncated).toBe(reference.truncated);

			if (result.truncated) {
				expect(result.spans).toEqual([]);
			}
		}
	});

	it("matches 1,000 dense 23 KiB messages in under 10 seconds", () => {
		const fragments = Array.from({ length: 23 }, (_, i) =>
			String.fromCodePoint(65 + i).repeat(1024),
		);
		const text = fragments.join("-");
		const value = fragments.slice(10, 12).join("-");
		const knownHashes = new Set([
			sha256Hex(value),
			...Array.from({ length: 10_000 }, (_, i) => sha256Hex(`synthetic-${String(i)}`)),
		]);

		const start = performance.now();

		for (let i = 0; i < 1_000; i++) {
			expect(matchKnownSecrets(text, knownHashes)).toEqual({ spans: [value], truncated: false });
		}

		expect(performance.now() - start).toBeLessThan(10_000);
	}, 15_000);
});
