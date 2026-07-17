import { createHash } from "node:crypto";

import type { Emission } from "../emission.ts";

// Fingerprints use the persisted semantic form, not incidental JSON key order. Optional null/empty
// spellings normalize identically because they produce the same durable event row.
export function emissionFingerprint(e: Emission): string {
	const canonical = {
		schema_version: 1,
		id: e.id,
		type: e.type,
		ts: new Date(e.ts).toISOString(),
		source: {
			service: e.source.service,
			host: e.source.host ?? null,
			agent: e.source.agent ?? null,
		},
		subject: e.subject,
		subject_kind: e.subject_kind ?? null,
		severity: e.severity,
		action: e.action ?? null,
		task_id: e.task_id ?? null,
		scope: e.scope,
		dimensions: e.dimensions ?? {},
		measures: e.measures ?? {},
		links: e.links ?? [],
		body_ref: e.body_ref ?? null,
		meta: e.meta ?? {},
	};
	return createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
		.join(",")}}`;
}
