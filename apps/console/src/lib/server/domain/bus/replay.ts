// Lake replay for a WS subscribe (contract §4.1). Runs inside withScopes so RLS filters to the
// subscriber's scopes; pattern + filter are applied in SQL where cheap, JS otherwise.

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import type { Emission } from "../emission.ts";
import { indefinitely } from "../iteration.ts";
import type { SubscribeSpec } from "./broker.ts";
import { matchPattern } from "./broker.ts";

interface EventRow {
	seq: string;
	id: string;
	type: string;
	ts: string;
	source_service: string;
	source_host: string | null;
	source_agent: string | null;
	subject: string;
	subject_kind: string | null;
	severity: string;
	action: string | null;
	task_id: string | null;
	scope: string;
	dimensions: Record<string, string | boolean>;
	measures: Record<string, number>;
	links: { rel: string; to: { kind: string; id: string } }[];
	body_ref: string | null;
	meta: Record<string, unknown>;
}

function rowToEmission(r: EventRow): Emission {
	return {
		schema_version: 1,
		id: r.id,
		type: r.type,
		ts: typeof r.ts === "string" ? r.ts : new Date(r.ts).toISOString(),
		source: { service: r.source_service, host: r.source_host, agent: r.source_agent },
		subject: r.subject,
		subject_kind: r.subject_kind as Emission["subject_kind"],
		severity: r.severity as Emission["severity"],
		action: r.action,
		task_id: r.task_id === null ? null : Number(r.task_id),
		scope: r.scope,
		dimensions: r.dimensions,
		measures: r.measures,
		links: r.links as Emission["links"],
		body_ref: r.body_ref,
		meta: r.meta as Emission["meta"],
	};
}

const SEV_ORDER = ["debug", "info", "warn", "danger", "p0"];
const PAGE = 5000;

export function makeReplay(app: Sql) {
	return async function replay(
		spec: SubscribeSpec,
		throughSeq: number,
		onRow: (seq: number, e: Emission) => void,
	): Promise<void> {
		// Paginate the WHOLE (since, through] range in seq order inside ONE scoped transaction — no
		// silent truncation (codex N1a P1). RLS filters to the subscriber's scopes; pattern/filter
		// are applied here for the globs SQL can't express.
		const since = spec.since ?? 0;
		const usePrefilter = spec.pattern !== "*" && !spec.pattern.startsWith("*.");
		const like = spec.pattern.endsWith(".*") ? `${spec.pattern.slice(0, -1)}%` : spec.pattern;
		const f = spec.filter;
		await withScopes(app, spec.scopes, async (tx) => {
			let cursor = since;
			for await (const iteration of indefinitely()) {
				void iteration;
				const rows = usePrefilter
					? await tx<EventRow[]>`select * from events where seq > ${cursor} and seq <= ${throughSeq}
							and (type = ${like} or type like ${like}) order by seq asc limit ${PAGE}`
					: await tx<EventRow[]>`select * from events where seq > ${cursor} and seq <= ${throughSeq}
							order by seq asc limit ${PAGE}`;
				if (rows.length === 0) break;
				for (const r of rows) {
					cursor = Number(r.seq);
					if (!matchPattern(spec.pattern, r.type)) continue;
					if (f?.severity_gte && SEV_ORDER.indexOf(r.severity) < SEV_ORDER.indexOf(f.severity_gte))
						continue;
					if (f?.source_service && r.source_service !== f.source_service) continue;
					if (f?.subject && r.subject !== f.subject) continue;
					onRow(Number(r.seq), rowToEmission(r));
				}
				if (rows.length < PAGE) break;
			}
		});
	};
}
