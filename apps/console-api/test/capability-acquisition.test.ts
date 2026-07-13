import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { installCapabilityBundle, parseCapabilityBundle } from "../src/registry/loader.ts";

function encodedBundle(files: unknown): Buffer {
	return Buffer.from(JSON.stringify({ schema_version: 1, entrypoint: "SKILL.md", files }), "utf8");
}

describe("capability bundle loader", () => {
	it("installs a verified skill bundle into an agent-owned directory", async () => {
		const bytes = encodedBundle([
			{
				path: "SKILL.md",
				mode: 0o644,
				content_b64: Buffer.from("# Registry skill\n", "utf8").toString("base64"),
			},
		]);
		const bundle = parseCapabilityBundle(bytes, {
			algorithm: "sha256",
			digest: createHash("sha256").update(bytes).digest("hex"),
		});
		const root = await mkdtemp(join(tmpdir(), "registry-acquire-"));

		const receipt = await installCapabilityBundle(bundle, {
			root,
			capability: "skill.registry-check",
			kind: "skill",
			version: "1.2.0",
		});

		expect(await readFile(join(receipt.install_dir, "SKILL.md"), "utf8")).toBe(
			"# Registry skill\n",
		);
		expect((await stat(join(receipt.install_dir, "SKILL.md"))).mode & 0o777).toBe(0o644);
		expect(receipt.entrypoint).toBe(join(receipt.install_dir, "SKILL.md"));
	});

	it("rejects traversal and an integrity mismatch before writing", () => {
		const bytes = encodedBundle([
			{
				path: "../escape",
				mode: 0o755,
				content_b64: Buffer.from("nope", "utf8").toString("base64"),
			},
		]);
		expect(() =>
			parseCapabilityBundle(bytes, {
				algorithm: "sha256",
				digest: createHash("sha256").update(bytes).digest("hex"),
			}),
		).toThrow(/relative path/);
		expect(() =>
			parseCapabilityBundle(encodedBundle([]), {
				algorithm: "sha256",
				digest: "0".repeat(64),
			}),
		).toThrow(/integrity/);
		const embedded = encodedBundle([
			{
				path: "nested/../SKILL.md",
				mode: 0o644,
				content_b64: Buffer.from("nope", "utf8").toString("base64"),
			},
		]);
		expect(() =>
			parseCapabilityBundle(embedded, {
				algorithm: "sha256",
				digest: createHash("sha256").update(embedded).digest("hex"),
			}),
		).toThrow(/relative path/);
	});

	it("refuses to replace an unmanaged install instead of creating a publication gap", async () => {
		const bytes = encodedBundle([
			{
				path: "SKILL.md",
				mode: 0o644,
				content_b64: Buffer.from("replacement", "utf8").toString("base64"),
			},
		]);
		const bundle = parseCapabilityBundle(bytes, {
			algorithm: "sha256",
			digest: createHash("sha256").update(bytes).digest("hex"),
		});
		const root = await mkdtemp(join(tmpdir(), "registry-acquire-"));
		const unmanaged = join(root, "skills", "registry-check");
		await mkdir(unmanaged, { recursive: true });
		await writeFile(join(unmanaged, "SKILL.md"), "original");

		await expect(
			installCapabilityBundle(bundle, {
				root,
				capability: "skill.registry-check",
				kind: "skill",
				version: "2.0.0",
			}),
		).rejects.toThrow(/not managed/);
		expect(await readFile(join(unmanaged, "SKILL.md"), "utf8")).toBe("original");
	});
});
