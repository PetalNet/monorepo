import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { redact } from "./adapters.ts";

export async function locked<T>(dir: string, action: () => Promise<T>): Promise<T> {
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

function parseEvent(line: string): { event: string; runId?: string } {
	const parsed: unknown = JSON.parse(line);

	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("event" in parsed) ||
		typeof parsed.event !== "string" ||
		!parsed.event
	) {
		throw new Error("expected a ledger event");
	}

	const runId = "runId" in parsed && typeof parsed.runId === "string" ? parsed.runId : undefined;

	return runId === undefined ? { event: parsed.event } : { event: parsed.event, runId };
}

async function appendRows(ledger: string, events: object[]) {
	const rows = events.map((event) => {
		const line = JSON.stringify(event, (key, value: unknown) => {
			if (
				/^(?:authorization|[\w-]*(?:token|secret|password|api[_-]?key))$/iu.test(key) &&
				value !== null
			) {
				return "[REDACTED]";
			}

			return typeof value === "string" ? redact(value) : value;
		});

		parseEvent(line);

		return line;
	});
	const file = await open(ledger, "a+", 0o600);

	try {
		await file.chmod(0o600);
		const { size } = await file.stat();
		const last = Buffer.alloc(1);

		if (size > 0) {
			await file.read(last, 0, 1, size - 1);
		}

		const separator = size > 0 && last[0] !== 10 ? "\n" : "";

		await file.appendFile(`${separator}${rows.join("\n")}\n`);
	} finally {
		await file.close();
	}
}

export async function appendEvent(dir: string, event: object): Promise<void> {
	await locked(dir, () => appendRows(path.join(dir, "ledger.jsonl"), [event]));
}

export async function validateLedger(file: string) {
	const lines = createInterface({
		input: createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});
	const invalid: number[] = [];
	let count = 0;

	for await (const line of lines) {
		count++;

		try {
			parseEvent(line);
		} catch {
			invalid.push(count);
		}
	}

	return { count, invalid };
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

		const imported = new Set<string>();

		for (const line of previous.split("\n")) {
			try {
				const row = parseEvent(line);

				if (row.event === "seed-complete") {
					return;
				}

				if (row.event === "import" && row.runId) {
					imported.add(row.runId);
				}
			} catch {
				// Historical corrupt rows remain visible to validate-ledger.
			}
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

		const rows: object[] = [];

		for (const file of files.filter((name) => name.endsWith(".log")).toSorted()) {
			// oxlint-disable-next-line no-await-in-loop -- Bound memory while importing historical logs.
			const body = await readFile(path.join(legacy, file), "utf8");
			const hash = createHash("sha256").update(file).update(body).digest("hex");
			const runId = `legacy-${hash}`;

			if (imported.has(runId)) {
				continue;
			}

			const start = /^started (\S+) model=([\w.-]+)/mu.exec(body);
			const end = /^ended (\S+) rc=(\d+)/mu.exec(body);

			rows.push({
				event: "import",
				runId,
				kind: null,
				tier: null,
				model: start?.[2] ?? null,
				startedAt: start?.[1] ?? null,
				endedAt: end?.[1] ?? null,
				exitCode: end ? Number(end[2]) : null,
				sourceHash: hash,
			});
		}

		rows.push({ event: "seed-complete", count: rows.length });
		await appendRows(ledger, rows);
	});
}
