#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Turbo 2.11.7 loads every toolchain for --affected, before applying filters.
// Derive the JS lane from the single source of truth, without provisioning Rust.
const config = JSON.parse(readFileSync("turbo.json", "utf8"));
config.futureFlags.experimentalCargoWorkspaces = false;
const directory = mkdtempSync(join(tmpdir(), "petalnet-turbo-js-"));
try {
	const path = join(directory, "turbo.json");
	writeFileSync(path, JSON.stringify(config));
	const result = spawnSync(
		"pnpm",
		[
			"--config.verifyDepsBeforeRun=false",
			"exec",
			"turbo",
			"run",
			"--root-turbo-json",
			path,
			"--filter=@petalnet/*",
			...process.argv.slice(2),
		],
		{ stdio: "inherit" },
	);
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(directory, { recursive: true, force: true });
}
