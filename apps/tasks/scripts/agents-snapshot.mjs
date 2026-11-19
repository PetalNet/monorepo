#!/usr/bin/env -S node --experimental-strip-types
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { applyLedger } from "./agents-view/ledger.ts";
import { sortedAgents } from "./agents-view/model.ts";
import { body, json, prLinks, redact, string } from "./agents-view/safe.ts";
import { Turns } from "./agents-view/turns.ts";

const recentMs = 48 * 60 * 60 * 1000;

async function optionalFile(read, path) {
	try {
		return await read(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return "";

		throw error;
	}
}

function safeValues(value) {
	if (typeof value === "string") return redact(value);

	if (Array.isArray(value)) return value.map(safeValues);

	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValues(item)]));
	}

	return value;
}

// Read the ledger first: only an explicit, consistent launch classification permits content reads.
export async function snapshot({
	stateDir = join(homedir(), ".local/state/router"),
	now = Date.now(),
	read = readFile,
} = {}) {
	const ledger = await optionalFile(read, join(stateDir, "ledger.jsonl"));
	const runsDir = join(stateDir, "runs");
	const agents = new Map();
	const classes = new Map();

	for (const line of ledger.split("\n")) {
		const event = json(line);

		if (!event || !/^[\w-]+$/.test(string(event.runId))) continue;

		if (event.event === "launch") {
			const raw = string(event.dataClass);
			const dataClass = ["public", "sensitive", "parcs"].includes(raw) ? raw : "unknown";
			const prior = classes.get(event.runId);

			classes.set(event.runId, prior === undefined || prior === dataClass ? dataClass : "unknown");
		}

		applyLedger(agents, line, runsDir);
	}

	const runs = [];

	for (const run of sortedAgents(agents.values())) {
		if (run.status !== "running" && (run.endedAt || run.startedAt) < now - recentMs) continue;

		const runId = run.id.slice("router:".length);
		const dataClass = classes.get(runId) ?? "unknown";
		let output = "";
		let turns = [];
		let links = [];

		if (dataClass === "public" || dataClass === "sensitive") {
			const events = await optionalFile(read, join(runsDir, `${runId}.events.jsonl`));
			let transcript = events;

			if (run.status !== "running") {
				if (!transcript) transcript = await optionalFile(read, join(runsDir, `${runId}.log`));

				const rawOutput = await optionalFile(read, join(runsDir, `${runId}.out`));

				output = body(rawOutput);
				links = prLinks(rawOutput);
			}

			if (transcript) {
				const parser = new Turns(run);

				for (const line of transcript.split("\n")) if (line.trim()) parser.ingest(line);

				turns = parser.rows;
			}
		}

		const last = run.attempts.at(-1);
		const timedOut =
			run.status === "failed" &&
			(/timed?[_ -]?out|timeout/i.test(last?.failureClass ?? "") || last?.exitCode === 124);

		runs.push(
			safeValues({
				id: runId,
				name: basename(run.name),
				status: timedOut ? "timed out" : run.status,
				model: run.model,
				effort: run.effort,
				plan: run.plan,
				pool: last?.pool ?? "",
				kind: run.kind,
				tier: run.tier,
				dataClass,
				startedAt: run.startedAt || null,
				endedAt: run.endedAt,
				attempts: run.attempts,
				turns,
				output,
				links,
			}),
		);
	}

	return { updatedAt: new Date(now).toISOString(), runs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.stdout.write(`${JSON.stringify(await snapshot())}\n`);
	} catch (error) {
		process.stderr.write(`${redact(String(error))}\n`);
		process.exitCode = 1;
	}
}
