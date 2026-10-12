import { createHash } from "node:crypto";

import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectCreate } from "../src/lib/projects/schema";
import { canonicalDigest } from "../src/lib/server/projects/canonical";

describe("project command canonical input", () => {
	it("normalizes bounded strings before hashing", async () => {
		const input = Schema.decodeSync(ProjectCreate)({
			commandId: "b37797e1-5a79-4347-b3ae-d1e1c7cc7217",
			scope: " home ",
			title: " Title ",
			ask: " Ask ",
		});

		expect(input).toMatchObject({ scope: "home", title: "Title", ask: "Ask" });

		expect(
			await Effect.runPromise(
				canonicalDigest({ title: input.title, scope: input.scope, task: input.ask }),
			),
		).toBe(
			await Effect.runPromise(canonicalDigest({ task: "Ask", scope: "home", title: "Title" })),
		);

		expect(() => Schema.decodeSync(ProjectCreate)({ ...input, ask: " " })).toThrow();
		expect(() => Schema.decodeSync(ProjectCreate)({ ...input, title: "x".repeat(257) })).toThrow();
	});

	it("rejects non-JSON values rather than silently hashing lossy input", async () => {
		await Promise.all(
			[undefined, NaN, Infinity, 1n, new Date(), { value: undefined }].map((value) =>
				expect(Effect.runPromise(canonicalDigest(value))).rejects.toThrow(),
			),
		);
	});

	it("preserves canonical digests and rejects cyclic and sparse JSON", async () => {
		const shared = { z: 2, a: 1 };

		expect(await Effect.runPromise(canonicalDigest({ b: [shared, shared], a: null }))).toBe(
			createHash("sha256").update('{"a":null,"b":[{"a":1,"z":2},{"a":1,"z":2}]}').digest("hex"),
		);

		const cyclic: Record<string, unknown> = {};

		cyclic.self = cyclic;
		await expect(Effect.runPromise(canonicalDigest(cyclic))).rejects.toThrow();
		const sparse = [1];

		sparse.length = 2;
		await expect(Effect.runPromise(canonicalDigest(sparse))).rejects.toThrow();
	});
});
