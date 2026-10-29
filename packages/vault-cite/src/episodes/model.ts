import { z } from "zod";

export const episodeMetadataSchema = z.object({
	schema_version: z.literal(1),
	layer: z.literal("EPISODE"),
	source_type: z.literal("transcript"),
	access_tier: z.literal("PRIVATE"),
	agent_id: z.string(),
	session_id: z.string(),
	role: z.string(),
	ts: z.string(),
	origin_file: z.string(),
	origin_uuid: z.string().nullable(),
	scan_status: z.enum(["CLEAN", "MASKED", "QUARANTINED"]),
	redaction_rules: z.array(z.string()),
});
export type EpisodeMetadata = z.infer<typeof episodeMetadataSchema>;

export const scopeConfigSchema = z.object({
	rooms: z.array(z.string()).default([]),
	keywords: z.array(z.string()).default([]),
});
export type ScopeConfig = z.infer<typeof scopeConfigSchema>;

export interface SecretFinding {
	value: string;
	rule: string;
}

export interface IngestCounts {
	messagesIn: number;
	droppedScope: number;
	masked: number;
	droppedSecret: number;
	indexed: number;
	cursor: number;
	/**
	 * Episodes retroactively masked by the end-of-run sweep (only runs when the source db is fully
	 * drained, i.e. not stopped early by the disk guard): a value whose ONLY secret-shaped context
	 * came from a LATER batch can't be known at the time an EARLIER batch inserts it, since the
	 * known-value hash set only grows forward. 0 when the run didn't reach the end of the source db.
	 */
	sweepMasked: number;
	/**
	 * Episodes quarantined (text replaced with a quarantine marker, scan_status set to QUARANTINED)
	 * because the sweep could not exhaustively check them against the known-secret hash set:
	 * candidate enumeration hit its own limit, so completeness could not be guaranteed. Fail-closed
	 * rather than silently sampling (pullfrog's review on PR 535, round 2).
	 */
	sweepQuarantined: number;
}
