import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

const scripts = path.join(import.meta.dirname, "../scripts");
const made: string[] = [];
const stops: (() => void)[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();

	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory holding a stand-in `ssh`, first on PATH, so the scripts run without a network. */
const fakeSsh = (body: (dir: string) => string) => {
	const dir = mkdtempSync(path.join(tmpdir(), "vault-client-"));

	made.push(dir);
	mkdirSync(path.join(dir, "bin"));
	writeFileSync(path.join(dir, "bin/ssh"), `#!/usr/bin/env bash\n${body(dir)}\n`);
	chmodSync(path.join(dir, "bin/ssh"), 0o755);

	return { dir, env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env["PATH"]}` } };
};

const until = async (done: () => boolean) => {
	for (let tries = 0; tries < 200 && !done(); tries++) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	expect(done()).toBe(true);
};

describe("client scripts", () => {
	test("remote.sh gives ssh a connect timeout, so an unreachable host fails soon", () => {
		const { dir, env } = fakeSsh((root) => `printf '%s\\n' "$@" >'${root}/args'`);

		const ran = spawnSync(path.join(scripts, "remote.sh"), ["vault-host", "echo", "a b"], { env });

		expect(ran.status).toBe(0);
		const args = readFileSync(path.join(dir, "args"), "utf8").split("\n");
		const timeout = args.find((arg) => arg.startsWith("ConnectTimeout="));

		expect(Number(timeout?.split("=")[1])).toBeGreaterThan(0);
		expect(Number(timeout?.split("=")[1])).toBeLessThanOrEqual(30);
		expect(args).toContain("vault-host");
	});

	test("a pull killed part way leaves no partial copy and keeps the index it had", async () => {
		// The stand-in sends part of an index, says so, then stalls like a dropped connection.
		const { dir, env } = fakeSsh(
			(root) => `printf partial\necho $$ >'${root}/ssh.pid'\nexec sleep 30`,
		);
		const replica = path.join(dir, "replica");

		mkdirSync(replica);
		writeFileSync(path.join(replica, "index.sqlite"), "the index it had");

		writeFileSync(
			path.join(dir, "env"),
			`VAULT_HOST=vault-host\nVAULT_REMOTE=/vault.sh\nVAULT_REPLICA=${replica}\n`,
		);

		stops.push(() => {
			if (existsSync(path.join(dir, "ssh.pid"))) {
				try {
					process.kill(Number(readFileSync(path.join(dir, "ssh.pid"), "utf8")));
				} catch {
					// already gone
				}
			}
		});

		const pull = spawn(path.join(scripts, "client.sh"), ["pull-index"], {
			env: { ...env, VAULT_ENV: path.join(dir, "env") },
			stdio: "ignore",
		});
		const exited = new Promise((resolve) => pull.once("exit", resolve));
		const partials = () => readdirSync(replica).filter((name) => name !== "index.sqlite");

		await until(
			() =>
				existsSync(path.join(dir, "ssh.pid")) &&
				partials().some((name) => readFileSync(path.join(replica, name), "utf8") === "partial"),
		);

		pull.kill("SIGTERM");
		await exited;

		expect(partials()).toEqual([]);
		expect(readFileSync(path.join(replica, "index.sqlite"), "utf8")).toBe("the index it had");
	});
});
