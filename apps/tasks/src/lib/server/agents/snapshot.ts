import { z } from "zod";

import db from "../db.js";

const text = z.string().max(65_536);
const shortText = z.string().max(1024);
const time = z.number().finite().nonnegative().nullable();
const attempt = z.object({
	number: z.number().int().nonnegative(),
	model: shortText,
	effort: shortText,
	plan: shortText,
	pool: shortText,
	startedAt: z.number().finite().nonnegative(),
	endedAt: time,
	exitCode: z.number().int().nullable(),
	failureClass: shortText,
	handoff: z.boolean(),
});
const turn = z.object({
	id: shortText,
	kind: z.enum(["assistant", "user", "tool", "event"]),
	name: shortText,
	text,
	result: text,
	resultBytes: z.number().int().nonnegative().nullable(),
	status: z.enum(["running", "done", "failed"]),
	at: z.number().finite().nonnegative(),
});
const run = z
	.object({
		id: shortText.min(1),
		name: shortText,
		status: shortText,
		model: shortText,
		effort: shortText,
		plan: shortText,
		pool: shortText,
		kind: shortText,
		tier: shortText,
		dataClass: shortText.optional(),
		startedAt: time,
		endedAt: time,
		attempts: z.array(attempt).max(100),
		turns: z.unknown().optional(),
		output: z.unknown().optional(),
		links: z.unknown().optional(),
	})
	.transform((value, ctx) => {
		const dataClass =
			value.dataClass === "public" || value.dataClass === "sensitive" || value.dataClass === "parcs"
				? value.dataClass
				: "unknown";

		if (dataClass !== "public" && dataClass !== "sensitive") {
			return { ...value, dataClass, turns: [], output: "", links: [] };
		}

		const content = z
			.object({
				turns: z.array(turn).max(2000),
				output: text,
				links: z
					.array(
						shortText.regex(
							/^https:\/\/(?:github\.com|gitlab\.com)\/[\w.-]+\/[\w.-]+\/(?:pull|merge_requests|[\w.-]+\/merge_requests)\/\d+$/,
						),
					)
					.max(100),
			})
			.safeParse(value);

		if (!content.success) {
			ctx.addIssue({ code: "custom", message: "Invalid run content" });

			return z.NEVER;
		}

		return { ...value, dataClass, ...content.data };
	});
const snapshotSchema = z.object({
	updatedAt: z.iso.datetime({ precision: 3 }),
	runs: z.array(run).max(1000),
});

export type Snapshot = z.output<typeof snapshotSchema>;

// One conditional statement serializes concurrent writers and rejects equal or older timestamps.
db.exec(`CREATE TABLE IF NOT EXISTS agent_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1), updated_at INTEGER NOT NULL, snapshot TEXT NOT NULL
)`);

const save = db.prepare(`INSERT INTO agent_snapshot (id, updated_at, snapshot) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, snapshot=excluded.snapshot
  WHERE excluded.updated_at > agent_snapshot.updated_at`);
const read = db.prepare("SELECT snapshot FROM agent_snapshot WHERE id=1");

export function saveSnapshot(input: unknown): "saved" | "invalid" | "stale" {
	const parsed = snapshotSchema.safeParse(input);

	if (!parsed.success) {
		return "invalid";
	}

	const timestamp = Date.parse(parsed.data.updatedAt);

	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== parsed.data.updatedAt) {
		return "invalid";
	}

	return save.run(timestamp, JSON.stringify(parsed.data)).changes ? "saved" : "stale";
}

export function readSnapshot(): Snapshot | null {
	const row = read.get();

	return row
		? snapshotSchema.parse(JSON.parse(z.object({ snapshot: z.string() }).parse(row).snapshot))
		: null;
}
