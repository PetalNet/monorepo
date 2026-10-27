import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { diskGuard } from "../store.ts";
import type { Store } from "../store.ts";
import type { IngestCounts } from "./model.ts";
import { maskAll, redactBatch, sha256Hex } from "./redact.ts";
import { isDenied, loadScopeConfig } from "./scope.ts";
import { candidateSpans } from "./secrets.ts";
import { EpisodeStore } from "./store.ts";

const recallRowSchema = z.object({
	rowid: z.number(),
	text: z.string(),
	role: z.string().nullable(),
	session: z.string().nullable(),
	ts: z.string().nullable(),
	uuid: z.string().nullable(),
	file: z.string().nullable(),
});

export interface IngestOptions {
	batchSize?: number;
	scopeConfigPath?: string;
	agentId?: string;
}

/**
 * Retroactively masks a value whose only secret-shaped context arrived in a LATER batch than the
 * episode it also appears in bare. The forward-only known-value hash set (collected while scanning
 * ascending rowids) cannot protect an earlier episode from a value it doesn't know about yet, so
 * this sweep re-checks every already-indexed episode against the FINAL hash set once the source db
 * is fully drained. This is the one controlled exception to episode immutability: it only ever
 * narrows text (masks a value already proven secret), never changes an id, provenance, or anything
 * else.
 */
export function sweepResidualSecrets(episodes: EpisodeStore): {
	swept: number;
	quarantined: number;
} {
	const knownHashes = episodes.knownHashes();

	if (knownHashes.size === 0) {
		return { swept: 0, quarantined: 0 };
	}

	let swept = 0;
	let quarantined = 0;
	let pendingMask: { id: string; text: string }[] = [];
	let pendingQuarantine: string[] = [];

	const flush = () => {
		if (pendingMask.length === 0 && pendingQuarantine.length === 0) {
			return;
		}

		episodes.withTransaction(() => {
			for (const { id, text } of pendingMask) {
				const metadata = episodes.getMetadata(id);

				if (!metadata) {
					continue;
				}

				episodes.updateText(id, text, {
					...metadata,
					scan_status: "MASKED",
					redaction_rules: [...new Set([...metadata.redaction_rules, "known-value"])],
				});

				swept++;
			}

			for (const id of pendingQuarantine) {
				const metadata = episodes.getMetadata(id);

				if (!metadata) {
					continue;
				}

				episodes.updateText(
					id,
					"[QUARANTINED: candidate enumeration limit reached; completeness could not be guaranteed]",
					{
						...metadata,
						scan_status: "QUARANTINED",
						redaction_rules: [...new Set([...metadata.redaction_rules, "quarantined-limit"])],
					},
				);

				quarantined++;
			}
		});

		pendingMask = [];
		pendingQuarantine = [];
	};

	for (const { id, text } of episodes.allText()) {
		const { spans, truncated } = candidateSpans(text);

		if (truncated) {
			// Fail closed: this episode's candidate coverage against the known-secret
			// hash set could not be guaranteed complete, so leaving it indexed as-is
			// would risk a known secret staying searchable (pullfrog's review on PR
			// 535, round 2). Quarantine rather than silently skip it.
			pendingQuarantine.push(id);
		} else {
			const values = new Map<string, string>();

			for (const value of spans) {
				if (!values.has(value) && knownHashes.has(sha256Hex(value))) {
					values.set(value, "known-value");
				}
			}

			if (values.size > 0) {
				let masked = text;

				for (const [value, rule] of [...values.entries()].toSorted(
					(a, b) => b[0].length - a[0].length,
				)) {
					masked = maskAll(masked, value, rule);
				}

				pendingMask.push({ id, text: masked });
			}
		}

		if (pendingMask.length + pendingQuarantine.length >= 500) {
			flush();
		}
	}

	flush();

	return { swept, quarantined };
}

/**
 * Streams rows out of a recall-index SQLite db (~/.claude/bin/recall-index's `messages` FTS5 table
 * + `file_state` cursor shape) in batches, never loading the whole table into memory, and writes
 * immutable episode rows into the vault store. Re-running with the same db path only adds messages
 * past the last-seen rowid (per-source-path cursor), so it never duplicates.
 */
export function ingestRecallDb(
	store: Store,
	recallDbPath: string,
	options: IngestOptions = {},
): IngestCounts {
	const batchSize = options.batchSize ?? 500;
	const agentId = options.agentId ?? process.env["VAULT_AGENT_ID"] ?? "unknown";
	const episodes = new EpisodeStore(store);
	const scope = loadScopeConfig(options.scopeConfigPath ?? process.env["EPISODES_SCOPE_CONFIG"]);
	const sourcePath = path.resolve(recallDbPath);
	const counts: IngestCounts = {
		messagesIn: 0,
		droppedScope: 0,
		masked: 0,
		droppedSecret: 0,
		indexed: 0,
		cursor: episodes.cursor(sourcePath),
		sweepMasked: 0,
		sweepQuarantined: 0,
	};

	const recall = new DatabaseSync(sourcePath, { readOnly: true });
	let reachedEnd = false;

	try {
		for (;;) {
			diskGuard(store.root);

			const rows = recallRowSchema
				.array()
				.parse(
					recall
						.prepare(
							"SELECT rowid,text,role,session,ts,uuid,file FROM messages WHERE rowid>? ORDER BY rowid LIMIT ?",
						)
						.all(counts.cursor, batchSize),
				);

			if (rows.length === 0) {
				reachedEnd = true;

				break;
			}

			counts.messagesIn += rows.length;

			const scoped = rows.filter((row) => {
				const denied = isDenied(scope, row.session ?? "", row.text);

				if (denied) {
					counts.droppedScope++;
				}

				return !denied;
			});

			const idFor = (row: z.infer<typeof recallRowSchema>) =>
				EpisodeStore.episodeId(row.file ?? sourcePath, row.uuid, row.rowid);

			const knownHashes = episodes.knownHashes();
			const { messages: redacted, newHashes } = redactBatch(
				scoped.map((row) => ({ id: idFor(row), text: row.text })),
				knownHashes,
			);

			const redactedById = new Map(redacted.map((message) => [message.id, message]));
			const lastRow = rows.at(-1);

			if (!lastRow) {
				break;
			}

			// One transaction per batch, not one implicit transaction per row:
			// at recall.db's real scale a commit-per-row insert loop dominates
			// wall time far more than the redaction scan does. Batch counts are
			// only folded into the running totals after a successful commit, so
			// a rolled-back batch never reports progress the store doesn't have.
			const batchCounts = episodes.withTransaction(() => {
				const batch = { masked: 0, droppedSecret: 0, indexed: 0 };

				episodes.addKnownHashes(newHashes);

				for (const row of scoped) {
					const id = idFor(row);
					const result = redactedById.get(id);

					if (result?.text == null) {
						batch.droppedSecret++;

						continue;
					}

					const masked = result.rules.length > 0;

					if (masked) {
						batch.masked++;
					}

					const inserted = episodes.insert(
						id,
						{
							schema_version: 1,
							layer: "EPISODE",
							source_type: "transcript",
							access_tier: "PRIVATE",
							agent_id: agentId,
							session_id: row.session ?? "",
							role: row.role ?? "unknown",
							ts: row.ts ?? "",
							origin_file: row.file ?? sourcePath,
							origin_uuid: row.uuid ?? null,
							scan_status: masked ? "MASKED" : "CLEAN",
							redaction_rules: result.rules,
						},
						result.text,
					);

					if (inserted) {
						batch.indexed++;
					}
				}

				episodes.setCursor(sourcePath, lastRow.rowid);

				return batch;
			});

			counts.masked += batchCounts.masked;
			counts.droppedSecret += batchCounts.droppedSecret;
			counts.indexed += batchCounts.indexed;
			counts.cursor = lastRow.rowid;
		}
	} finally {
		recall.close();
	}

	if (reachedEnd) {
		const sweep = sweepResidualSecrets(episodes);

		counts.sweepMasked = sweep.swept;
		counts.sweepQuarantined = sweep.quarantined;
	}

	return counts;
}
