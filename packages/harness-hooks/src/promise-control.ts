import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { configFromEnv, depsFromEnv, Ledger } from "./promise-ledger.ts";

export type Control =
	| { action: "snapshot" | "pause" | "resume" }
	| { action: "drop"; id: number; reason: string }
	| { action: "snooze"; id: number; hours: number };

const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function parseControl(value: unknown): Control {
	if (!object(value)) {
		throw new Error("invalid-command");
	}

	const action = value["action"];

	if (action === "snapshot" || action === "pause" || action === "resume") {
		return { action };
	}

	const id = value["id"];

	if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
		throw new Error("invalid-id");
	}

	if (
		action === "drop" &&
		typeof value["reason"] === "string" &&
		value["reason"].trim() &&
		value["reason"].length <= 500
	) {
		return { action, id, reason: value["reason"].trim() };
	}

	if (
		action === "snooze" &&
		typeof value["hours"] === "number" &&
		Number.isInteger(value["hours"]) &&
		value["hours"] >= 1 &&
		value["hours"] <= 24 * 30
	) {
		return { action, id, hours: value["hours"] };
	}

	throw new Error("invalid-command");
}

export function schedulerState(file: string): "active" | "paused" | "missing" | "unavailable" {
	try {
		const raw: unknown = JSON.parse(readFileSync(file, "utf8"));

		if (!object(raw) || !Array.isArray(raw["jobs"])) {
			return "unavailable";
		}

		const job: unknown = raw["jobs"].find(
			(entry: unknown) => object(entry) && entry["name"] === "promise-sweep",
		);

		if (job === undefined) {
			return "missing";
		}

		return object(job) && typeof job["enabled"] === "boolean"
			? job["enabled"]
				? "active"
				: "paused"
			: "unavailable";
	} catch {
		return "unavailable";
	}
}

/** Local command boundary for the authenticated tasks page. It never runs a sweep or resumes cron. */
export function control(ledger: Ledger, command: Control, jobsFile: string) {
	switch (command.action) {
		case "snapshot":
			break;
		case "pause":
			ledger.setMeta("paused", "1");

			break;
		case "resume":
			ledger.setMeta("paused", "0");

			break;
		case "drop":
			ledger.closeItem(command.id, "dropped", "control-page", command.reason);

			break;
		case "snooze":
			ledger.snooze(command.id, ledger.deps.now() + command.hours * 3_600_000);

			break;
	}

	const last: unknown = JSON.parse(ledger.meta("last_sweep") ?? "null");

	return {
		paused: ledger.meta("paused") === "1",
		scheduler: schedulerState(jobsFile),
		lastSweep: object(last) && typeof last["at"] === "string" ? last["at"] : null,
		items: ledger.items().map((item) => ({
			id: item.id,
			kind: item.kind,
			text: item.text,
			due: item.due,
			created: item.created,
			room: item.room,
			surface: item.surface,
			event: item.event_id,
			attention: item.attention,
		})),
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	try {
		const input = readFileSync(0, "utf8");

		if (input.length > 4096) {
			throw new Error("input-too-large");
		}

		const command = parseControl(JSON.parse(input));
		const config = configFromEnv();

		if (!existsSync(config.store)) {
			throw new Error("ledger-unavailable");
		}

		const ledger = new Ledger(config, depsFromEnv());

		try {
			process.stdout.write(
				`${JSON.stringify(control(ledger, command, path.join(process.env["HERMES_HOME"] ?? path.join(homedir(), ".hermes-janet"), "cron/jobs.json")))}\n`,
			);
		} finally {
			ledger.close();
		}
	} catch {
		process.stderr.write("promise-control: command unavailable\n");
		process.exitCode = 2;
	}
}
