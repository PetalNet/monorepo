import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { violations, type Exception } from "./check.ts";

const allowlist = JSON.parse(
	readFileSync(new URL("allowlist.json", import.meta.url), "utf8"),
) as Exception[];
const root = fileURLToPath(new URL("../..", import.meta.url));
const none = () => "{}";
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

	it("fails a new Python project and a new Python server", () => {
		expect(violations(["apps/newsvc/pyproject.toml", "apps/newsvc/app.py"], [], none)).toEqual([
			"apps/newsvc/pyproject.toml: Python service or script",
			"apps/newsvc/app.py: Python service or script",
		]);
	});

	it("lets Python files into an allowlisted project", () => {
		const entry = { path: "apps/old", reason: "existing Python service" };

		expect(
			violations(["apps/old/pyproject.toml", "apps/old/new_module.py"], [entry], none),
		).toEqual([]);
	});

	it("fails a new app without the Effect packages and passes one with them", () => {
		expect(violations(["apps/new/package.json"], [], none)).toEqual([
			"apps/new/package.json: app without @petalnet/effect-sveltekit or @petalnet/effect-api",
		]);

		expect(
			violations(
				["apps/new/package.json"],
				[],
				manifest({ "@petalnet/effect-sveltekit": "workspace:*" }),
			),
		).toEqual([]);

		expect(
			violations(
				["apps/new/package.json"],
				[],
				manifest({ "@petalnet/effect-api": "workspace:*" }),
			),
		).toEqual([]);
	});

	it("flags an allowlist entry whose files are gone", () => {
		expect(violations([], [{ path: "apps/gone", reason: "was a service" }], none)).toEqual([
			'allowlist.json: "apps/gone" matches no tracked file; remove the entry',
		]);
	});
});
