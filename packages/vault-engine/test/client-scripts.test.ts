import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const scripts = path.join(import.meta.dirname, "../scripts");
const made: string[] = [];
const stops: (() => void)[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) {
		stop();
	}

	for (const dir of made.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A directory holding a stand-in `ssh`, first on PATH, so the scripts run without a network. */
const fakeSsh = (body: (dir: string) => string) => {
	const dir = mkdtempSync(path.join(tmpdir(), "vault-client-"));

	made.push(dir);
	mkdirSync(path.join(dir, "bin"));
	writeFileSync(path.join(dir, "bin/ssh"), `#!/usr/bin/env bash\n${body(dir)}\n`);
	chmodSync(path.join(dir, "bin/ssh"), 0o755);

	return {
		dir,
		env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env["PATH"] ?? ""}` },
	};
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
		const exited = once(pull, "exit");
		const partials = () => readdirSync(replica).filter((name) => name !== "index.sqlite");

		// Wait until the partial copy is on disk and the stand-in is stalled.
		await vi.waitFor(
			() => {
				expect(existsSync(path.join(dir, "ssh.pid"))).toBe(true);

				expect(partials().map((name) => readFileSync(path.join(replica, name), "utf8"))).toEqual([
					"partial",
				]);
			},
			{ timeout: 10_000, interval: 25 },
		);

		pull.kill("SIGTERM");
		await exited;

		expect(partials()).toEqual([]);
		expect(readFileSync(path.join(replica, "index.sqlite"), "utf8")).toBe("the index it had");
	}, 20_000);

	test("a pull sweeps partial copies left long ago, and leaves a recent one alone", () => {
		const { dir, env } = fakeSsh(() => "printf 'a new index'");
		const replica = path.join(dir, "replica");
		const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

		mkdirSync(replica);
		writeFileSync(path.join(replica, "index.sqlite.oldold"), "partial");
		utimesSync(path.join(replica, "index.sqlite.oldold"), hoursAgo, hoursAgo);
		writeFileSync(path.join(replica, "index.sqlite.newnew"), "partial");

		writeFileSync(
			path.join(dir, "env"),
			`VAULT_HOST=vault-host\nVAULT_REMOTE=/vault.sh\nVAULT_REPLICA=${replica}\n`,
		);

		const ran = spawnSync(path.join(scripts, "client.sh"), ["pull-index"], {
			env: { ...env, VAULT_ENV: path.join(dir, "env") },
		});

		expect(ran.status).toBe(0);
		expect(readdirSync(replica).toSorted()).toEqual(["index.sqlite", "index.sqlite.newnew"]);
		expect(readFileSync(path.join(replica, "index.sqlite"), "utf8")).toBe("a new index");
	});
});
