import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { redact } from "./adapters.ts";

export interface Availability {
	cooldowns: Record<string, number>;
	badOffers: Record<string, number>;
	signedOut: Record<string, number>;
}

export async function readAvailability(dir: string): Promise<Availability> {
	let raw: unknown;

	try {
		raw = JSON.parse(await readFile(path.join(dir, "availability.json"), "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { cooldowns: {}, badOffers: {}, signedOut: {} };
		}

		throw error;
	}

	if (!raw || typeof raw !== "object") {
		throw new Error("invalid router availability");
	}

	const result: Availability = { cooldowns: {}, badOffers: {}, signedOut: {} };

	for (const key of ["cooldowns", "badOffers", "signedOut"] as const) {
		const entries: unknown = key in raw ? Reflect.get(raw, key) : undefined;

		if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
			throw new Error("invalid router availability");
		}

		for (const [id, until] of Object.entries(entries)) {
			if (typeof until !== "number" || !Number.isFinite(until)) {
				throw new TypeError("invalid router timestamp");
			}

			Object.defineProperty(result[key], id, {
				value: until,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}

	return result;
}

async function locked<T>(dir: string, action: () => Promise<T>): Promise<T> {
	await mkdir(dir, { recursive: true, mode: 0o700 });

	const lock = spawn(
		"flock",
		["-x", path.join(dir, ".lock"), "sh", "-c", "printf ready; cat >/dev/null"],
		{ stdio: ["pipe", "pipe", "ignore"] },
	);
	const closed = once(lock, "close");

	await Promise.race([
		once(lock.stdout, "data"),
		closed.then(() => {
			throw new Error("router flock failed");
		}),
	]);

	try {
		return await action();
	} finally {
		lock.stdin.end();
		await closed;
	}
}

export async function markUnavailable(
	dir: string,
	key: keyof Availability,
	id: string,
	until: number,
): Promise<void> {
	await locked(dir, async () => {
		const state = await readAvailability(dir);

		state[key][id] = Math.max(state[key][id] ?? 0, until);
		const temp = path.join(dir, `.availability-${crypto.randomUUID()}`);

		await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
		await rename(temp, path.join(dir, "availability.json"));
	});
}

export async function appendEvent(dir: string, event: object): Promise<void> {
	await locked(dir, async () => {
		await appendFile(path.join(dir, "ledger.jsonl"), `${redact(JSON.stringify(event))}\n`, {
			mode: 0o600,
		});

		await chmod(path.join(dir, "ledger.jsonl"), 0o600);
	});
}

/** Imports metadata only; old logs are not quality labels and can contain credentials. */
export async function seedLedger(dir: string, legacy: string): Promise<void> {
	await locked(dir, async () => {
		const ledger = path.join(dir, "ledger.jsonl");
		let previous = "";

		try {
			previous = await readFile(ledger, "utf8");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
		}

		if (previous.split("\n").some((line) => line.includes('"event":"seed-complete"'))) {
			return;
		}

		let files: string[];

		try {
			files = await readdir(legacy);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				files = [];
			} else {
				throw error;
			}
		}

		const rows: string[] = [];

		for (const file of files.filter((name) => name.endsWith(".log")).toSorted()) {
			// oxlint-disable-next-line no-await-in-loop -- Bound memory while importing historical logs.
			const body = await readFile(path.join(legacy, file), "utf8");
			const hash = createHash("sha256").update(file).update(body).digest("hex");
			const runId = `legacy-${hash}`;

			if (previous.includes(runId)) {
				continue;
			}

			const start = /^started (\S+) model=([\w.-]+)/mu.exec(body);
			const end = /^ended (\S+) rc=(\d+)/mu.exec(body);

			rows.push(
				JSON.stringify({
					event: "import",
					runId,
					kind: null,
					tier: null,
					model: start?.[2] ?? null,
					startedAt: start?.[1] ?? null,
					endedAt: end?.[1] ?? null,
					exitCode: end ? Number(end[2]) : null,
					sourceHash: hash,
				}),
			);
		}

		rows.push(JSON.stringify({ event: "seed-complete", count: rows.length }));
		await appendFile(ledger, `${redact(rows.join("\n"))}\n`, { mode: 0o600 });
		await chmod(ledger, 0o600);
	});
}
