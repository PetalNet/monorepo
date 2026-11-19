import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { violations, type Exception } from "./check.ts";

const allowlist = JSON.parse(
	readFileSync(new URL("allowlist.json", import.meta.url), "utf8"),
) as Exception[];
const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = (deps: Record<string, string>) => () => JSON.stringify({ dependencies: deps });

describe("effect-default check", () => {
	it("passes on the tracked tree", () => {
		const files = execFileSync("git", ["ls-files", "-z"], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 1 << 26,
		})
			.split("\0")
			.filter(Boolean);

		expect(violations(files, allowlist, (file) => readFileSync(`${root}${file}`, "utf8"))).toEqual(
			[],
		);
	});

	it("gives every exception a one-line reason", () => {
		for (const entry of allowlist) {
			expect(entry.reason).toMatch(/^[^\n]{10,}$/u);
		}
	});

	it("fails a new JS web app or server on another stack", () => {
		for (const dep of ["@sveltejs/kit", "express", "hono", "fastify"]) {
			expect(violations(["apps/new/package.json"], [], manifest({ [dep]: "1.0.0" }))).toEqual([
				"apps/new/package.json: JS web app or server without @petalnet/effect-sveltekit or @petalnet/effect-api",
			]);
		}
	});

	it("passes a new app built on the Effect packages", () => {
		const deps = { "@sveltejs/kit": "1.0.0", "@petalnet/effect-sveltekit": "workspace:*" };

		expect(violations(["apps/new/package.json"], [], manifest(deps))).toEqual([]);

		expect(
			violations(
				["apps/new/package.json"],
				[],
				manifest({ hono: "1.0.0", "@petalnet/effect-api": "workspace:*" }),
			),
		).toEqual([]);
	});

	it("does not touch Python, Rust, Flutter, tooling or non-server packages", () => {
		expect(
			violations(
				[
					"apps/ml/pyproject.toml",
					"apps/ml/serve.py",
					"apps/rust/Cargo.toml",
					"apps/cli/package.json",
				],
				[],
				manifest({ effect: "1.0.0" }),
			),
		).toEqual([]);
	});

	it("lets an allowlisted app through", () => {
		const entry = { path: "apps/old", reason: "predates effect-sveltekit" };

		expect(
			violations(["apps/old/package.json"], [entry], manifest({ "@sveltejs/kit": "1.0.0" })),
		).toEqual([]);
	});

	it("flags an allowlist entry whose files are gone", () => {
		expect(violations([], [{ path: "apps/gone", reason: "was a service" }], () => "{}")).toEqual([
			'allowlist.json: "apps/gone" matches no tracked file; remove the entry',
		]);
	});
});
