#!/usr/bin/env -S node --experimental-strip-types
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { applyLedger } from "./agents-view/ledger.ts";
import { sortedAgents } from "./agents-view/model.ts";
import { body, clamp, json, prLinks, redact, string } from "./agents-view/safe.ts";
import { Turns } from "./agents-view/turns.ts";

const recentMs = 48 * 60 * 60 * 1000;
const maxRuns = 1000;
const maxAttempts = 100;
const maxTurns = 2000;
const maxLinks = 100;
const maxShortText = 1024;
const maxText = 65_536;
const maxPayloadBytes = 4 * 1024 * 1024;
const readConcurrency = 16;
const validLink =
	/^https:\/\/(?:github\.com|gitlab\.com)\/[\w.-]+\/[\w.-]+\/(?:pull|merge_requests|[\w.-]+\/merge_requests)\/\d+$/;

async function optionalFile(read, filePath) {
	try {
		return await read(filePath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") {
			return "";
		}

		throw error;
	}
}

function safeValues(value) {
	if (typeof value === "string") {
		return redact(value);
	}

	if (Array.isArray(value)) {
		return value.map(safeValues);
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValues(item)]));
	}

	return value;
}

async function mapLimited(items, limit, fn) {
	const results = Array.from({ length: items.length });
	let next = 0;

	async function worker() {
		const index = next++;

		if (index >= items.length) {
			return;
		}

		results[index] = await fn(items[index]);
		await worker();
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));

	return results;
}

function clampRun(safeRun) {
	safeRun.id = safeRun.id.slice(0, maxShortText);

	for (const key of [
		"name",
		"status",
		"model",
		"effort",
		"plan",
		"pool",
		"kind",
		"tier",
		"dataClass",
	]) {
		safeRun[key] = clamp(safeRun[key], maxShortText);
	}

	for (const attempt of safeRun.attempts) {
		for (const key of ["model", "effort", "plan", "pool", "failureClass"]) {
			attempt[key] = clamp(attempt[key], maxShortText);
		}
	}

	for (const turn of safeRun.turns) {
		turn.id = clamp(turn.id, maxShortText);
		turn.name = clamp(turn.name, maxShortText);
		turn.text = clamp(turn.text, maxText);
		turn.result = clamp(turn.result, maxText);
	}

	safeRun.output = clamp(safeRun.output, maxText);

	safeRun.links = safeRun.links
		.filter((link) => link.length <= maxShortText && validLink.test(link))
		.slice(0, maxLinks);

	return safeRun;
}

function fitSnapshot(updatedAt, runs, limit = maxPayloadBytes) {
	const payload = { updatedAt, runs };
	let bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

	if (bytes <= limit) {
		return payload;
	}

	// Trim oldest runs' oldest turns first so active/newest runs keep their recent turns.
	for (let i = runs.length - 1; i >= 0 && bytes > limit; i--) {
		const run = runs[i];

		while (run.turns.length > 0 && bytes > limit) {
			const excess = bytes - limit;
			let saved = 0;
			let drop = 0;

			while (drop < run.turns.length && saved < excess) {
				saved += Buffer.byteLength(JSON.stringify(run.turns[drop]), "utf8") + 1;
				drop++;
			}

			run.turns = run.turns.slice(drop);
			bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
		}
	}

	if (bytes > limit) {
		let estimated = bytes;

		for (let i = runs.length - 1; i >= 0 && estimated > limit; i--) {
			if (!runs[i].output) {
				continue;
			}

			estimated -= Buffer.byteLength(JSON.stringify(runs[i].output), "utf8") - 2;
			runs[i].output = "";
		}

		bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	}

	while (runs.length > 0 && bytes > limit) {
		let estimated = bytes;

		while (runs.length > 0 && estimated > limit) {
			const dropped = runs.pop();

			estimated -= Buffer.byteLength(JSON.stringify(dropped), "utf8") + 1;
		}

		bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	}

	return payload;
}

// Read the ledger first: only an explicit, consistent launch classification permits content reads.
export async function snapshot({
	stateDir = path.join(homedir(), ".local/state/router"),
	now = Date.now(),
	read = readFile,
} = {}) {
	const ledger = await optionalFile(read, path.join(stateDir, "ledger.jsonl"));
	const runsDir = path.join(stateDir, "runs");
	const agents = new Map();
	const classes = new Map();

	for (const line of ledger.split("\n")) {
		const event = json(line);

		if (!event || !/^[\w-]+$/.test(string(event.runId))) {
			continue;
		}

		if (event.event === "launch" || event.dataClass !== undefined) {
			const raw = string(event.dataClass);
			const dataClass = ["public", "sensitive", "parcs"].includes(raw) ? raw : "unknown";
			const prior = classes.get(event.runId);

			classes.set(event.runId, prior === undefined || prior === dataClass ? dataClass : "unknown");
		}

		applyLedger(agents, line, runsDir);
	}

	const recent = sortedAgents(agents.values())
		.filter((run) => run.status === "running" || (run.endedAt || run.startedAt) >= now - recentMs)
		.slice(0, maxRuns);

	const runs = await mapLimited(recent, readConcurrency, async (run) => {
		const runId = run.id.slice("router:".length);
		const dataClass = classes.get(runId) ?? "unknown";
		let output = "";
		let turns = [];
		let links = [];

		if (dataClass === "public" || dataClass === "sensitive") {
			const [events, rawOutput] = await Promise.all([
				optionalFile(read, path.join(runsDir, `${runId}.events.jsonl`)),
				run.status === "running"
					? Promise.resolve("")
					: optionalFile(read, path.join(runsDir, `${runId}.out`)),
			]);
			let transcript = events;

			if (run.status !== "running") {
				if (!transcript) {
					transcript = await optionalFile(read, path.join(runsDir, `${runId}.log`));
				}

				output = body(rawOutput);
				links = prLinks(rawOutput);
			}

			if (transcript) {
				const parser = new Turns(run);

				for (const line of transcript.split("\n")) {
					if (line.trim()) {
						parser.ingest(line);
					}
				}

				turns = parser.rows.slice(-maxTurns);
			}

			links = [...new Set([...run.links, ...links])];
		}

		const last = run.attempts.at(-1);
		const timedOut =
			run.status === "failed" &&
			(/timed?[_ -]?out|timeout/i.test(last?.failureClass ?? "") || last?.exitCode === 124);

		return clampRun(
			safeValues({
				id: runId,
				name: path.basename(run.name),
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
				attempts: run.attempts.slice(-maxAttempts),
				turns,
				output,
				links,
			}),
		);
	});

	return fitSnapshot(new Date(now).toISOString(), runs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.stdout.write(`${JSON.stringify(await snapshot())}\n`);
	} catch (error) {
		process.stderr.write(`${redact(String(error))}\n`);
		process.exitCode = 1;
	}
}
