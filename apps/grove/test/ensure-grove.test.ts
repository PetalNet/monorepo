import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const source = resolve(import.meta.dirname, "../../../.agents/ensure-grove");
const temporaryDirectories: string[] = [];

const run = (
	command: string,
	arguments_: readonly string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv },
) =>
	new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
		const child = spawn(command, arguments_, options);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			done({ code, stdout, stderr });
		});
	});

const fixture = async (preflightStatus = "ready") => {
	const root = await mkdtemp(join(tmpdir(), "ensure-grove-"));
	temporaryDirectories.push(root);
	await mkdir(join(root, ".agents"), { recursive: true });
	await mkdir(join(root, ".amp/portals"), { recursive: true });
	await mkdir(join(root, "bin"), { recursive: true });
	await writeFile(join(root, ".agents/ensure-grove"), await readFile(source));
	await chmod(join(root, ".agents/ensure-grove"), 0o755);
	await writeFile(
		join(root, ".amp/portals/grove.json"),
		JSON.stringify({ links: [{ url: "https://grove.portal.test" }] }),
	);
	await writeFile(
		join(root, ".amp/portals/grove-oidc.json"),
		JSON.stringify({ links: [{ url: "https://oidc.portal.test" }] }),
	);
	await writeFile(
		join(root, "bin/amp"),
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$AMP_CALLS"\nprintf '%s\\n' '{"status":"healthy"}'\n`,
	);
	await writeFile(
		join(root, "bin/curl"),
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$CURL_CALLS"\nprintf '%s\\n' '${JSON.stringify({ status: preflightStatus, checks: [] })}'\n`,
	);
	await chmod(join(root, "bin/amp"), 0o755);
	await chmod(join(root, "bin/curl"), 0o755);
	const env = {
		...process.env,
		PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
		AMP_CALLS: join(root, "amp.calls"),
		CURL_CALLS: join(root, "curl.calls"),
	};
	return { root, env };
};

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("ensure Grove orb services", () => {
	it("is valid shell and emits portal manifests plus machine preflight", async () => {
		const { root, env } = await fixture();
		const syntax = await run("bash", ["-n", join(root, ".agents/ensure-grove")], {
			cwd: root,
			env,
		});
		expect(syntax).toMatchObject({ code: 0, stderr: "" });

		const ensured = await run(join(root, ".agents/ensure-grove"), [], { cwd: "/", env });

		expect(ensured.code).toBe(0);
		expect(JSON.parse(ensured.stdout)).toEqual({
			status: "ready",
			grovePortal: "https://grove.portal.test",
			oidcPortal: "https://oidc.portal.test",
			portalManifests: {
				grove: ".amp/portals/grove.json",
				oidc: ".amp/portals/grove-oidc.json",
			},
			services: { status: "healthy" },
			preflight: { status: "ready", checks: [] },
		});
		expect(await readFile(join(root, "amp.calls"), "utf8")).toBe("orb services ensure --json\n");
		expect(await readFile(join(root, "curl.calls"), "utf8")).toContain(
			"https://grove.portal.test/__dev/preflight",
		);
	});

	it("prints diagnostic JSON and fails when required preflight checks are not ready", async () => {
		const { root, env } = await fixture("not-ready");

		const ensured = await run(join(root, ".agents/ensure-grove"), [], { cwd: root, env });

		expect(ensured.code).toBe(1);
		expect(JSON.parse(ensured.stdout)).toMatchObject({
			status: "not-ready",
			preflight: { status: "not-ready" },
		});
	});
});
