#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

// Keep the selection keys identical to the job IDs in ci.yml.
const nativeJobs = [
	"manager-rust",
	"courier-rust",
	"dispatcher-rust",
	"control-plane-rust",
	"box-agent-rust",
	"point",
];

const command = process.argv[2];
if (command === "select") {
	const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
	const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha;
	const selected = Object.fromEntries(nativeJobs.map((job) => [job, !base]));
	let rust = !base;
	let js = !base;
	if (base) {
		// No rename detection: both the old and new path participate, including deletes.
		const paths = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"], {
			encoding: "utf8",
		})
			.split("\0")
			.filter(Boolean);
		const shared = paths.some((path) =>
			/^(?:\.github\/(?:workflows|codeql)\/|\.cargo\/|tools\/ci-manager\.mjs$|Cargo\.(?:toml|lock)$|rust-toolchain(?:\.toml)?$|mise\.(?:toml|lock)$)/u.test(
				path,
			),
		);
		for (const job of nativeJobs) {
			const app = job.replace(/-rust$/u, "");
			selected[job] = shared || paths.some((path) => path.startsWith(`apps/${app}/`));
		}
		rust =
			shared ||
			paths.some((path) =>
				/(?:\.rs$|(?:^|\/)Cargo\.(?:toml|lock)$|(?:^|\/)rust-toolchain(?:\.toml)?$|(?:^|\/)\.cargo\/)/u.test(
					path,
				),
			);
		// Turbo, not a second package/path graph, owns JS dependency propagation.
		const plan = JSON.parse(
			execFileSync(
				"pnpm",
				[
					"--config.verifyDepsBeforeRun=false",
					"exec",
					"turbo",
					"run",
					"build",
					"test",
					"--affected",
					"--dry=json",
				],
				{
					encoding: "utf8",
					env: { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: "HEAD" },
				},
			),
		);
		js = plan.tasks.some(
			(task) => task.command !== "<NONEXISTENT>" && ["build", "test"].includes(task.task),
		);
	}
	const outputs = { ...selected, rust, js, base: base ?? "", affected: Boolean(base) };
	for (const [key, value] of Object.entries(outputs)) {
		console.log(`${key}=${value}`);
		appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
	}
} else if (command === "gate") {
	const jobs = JSON.parse(process.env.NEEDS_JSON);
	const selection = jobs.select?.outputs ?? {};
	const errors = [];
	if (!["true", "false"].includes(selection.rust)) errors.push("Invalid Rust selection");
	const expect = (name, expected) => {
		const actual = jobs[name]?.result;
		console.log(`${name}: ${actual} (expected ${expected})`);
		if (actual !== expected) errors.push(`${name}: expected ${expected}, got ${actual}`);
	};
	for (const job of ["select", "check", "typos", "link-check", "zizmor"]) expect(job, "success");
	const conditional = {
		...Object.fromEntries(nativeJobs.map((job) => [job, selection[job]])),
		build: selection.js,
		test: selection.js,
		"codeql-js": process.env.CODEQL_ADVANCED,
		"codeql-rust": process.env.CODEQL_ADVANCED === "true" ? selection.rust : "false",
	};
	for (const [job, enabled] of Object.entries(conditional)) {
		if (!["true", "false"].includes(enabled)) errors.push(`${job}: invalid selection ${enabled}`);
		else expect(job, enabled === "true" ? "success" : "skipped");
	}
	for (const job of Object.keys(jobs)) {
		if (
			!["select", "check", "typos", "link-check", "zizmor", ...Object.keys(conditional)].includes(
				job,
			)
		)
			errors.push(`Unclassified job: ${job}`);
	}
	if (errors.length) throw new Error(errors.join("\n"));
} else {
	throw new Error("Usage: ci-manager.mjs select|gate");
}
