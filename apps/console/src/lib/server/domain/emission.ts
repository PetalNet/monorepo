// The L1 canonical emission shape (contract §2, schemas/emission.schema.json), validated at the
// ingest door. This is the one envelope that is both a bus signal and a lake statistic.

import { z } from "zod";

import { SCOPE_RE } from "./scope.ts";

export const SEVERITIES = ["debug", "info", "warn", "danger", "p0"] as const;
export type Severity = (typeof SEVERITIES)[number];

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const TYPE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const ACTION_HTTPS_HOSTS = new Set(["tasks.petalcat.dev"]);

/**
 * Emission actions are navigation targets, never executable URL payloads. Internal routes are
 * preferred; HTTPS is the only external scheme producers may persist.
 */
function isSafeEmissionAction(value: string): boolean {
	if (!value || value.trimStart().startsWith("//") || value.includes("\\")) return false;
	try {
		const internalBase = new URL("https://console.invalid/");
		const url = new URL(value, internalBase);
		return (
			url.username === "" &&
			url.password === "" &&
			(url.origin === internalBase.origin ||
				(url.protocol === "https:" && ACTION_HTTPS_HOSTS.has(url.hostname)))
		);
	} catch {
		return false;
	}
}

const actionTarget = z
	.string()
	.min(1)
	.max(512)
	.refine(isSafeEmissionAction, "action must be an internal route or HTTPS URL");

const linkTarget = z
	.object({
		kind: z.enum(["agent", "host", "service", "task", "card", "item", "user", "session", "other"]),
		id: z.string().max(256),
	})
	.strict();

const fieldMeta = z
	.object({
		unit: z.string().max(32).optional(),
		kind: z.enum(["gauge", "counter", "delta", "timestamp"]).optional(),
		cardinality: z.enum(["low", "medium", "high"]).optional(),
	})
	.strict();

// additionalProperties: true on the wire (dual-role envelope, Rule 1 exemption) — but we validate
// the known shape strictly enough to keep the lake honest, then pass unknown keys through in `meta`.
export const emissionSchema = z.object({
	schema_version: z.literal(1),
	id: z.uuid(),
	type: z.string().regex(TYPE_RE).max(128),
	ts: z.iso.datetime({ offset: true }),
	source: z.object({
		service: z.string().max(64),
		host: z.string().nullable().optional(),
		agent: z.string().regex(HANDLE_RE).nullable().optional(),
	}),
	subject: z.string().max(256),
	subject_kind: z
		.enum(["agent", "host", "service", "task", "card", "item", "user", "session", "other"])
		.nullable()
		.optional(),
	severity: z.enum(SEVERITIES),
	action: actionTarget.nullable().optional(),
	task_id: z.number().int().nullable().optional(),
	scope: z.string().regex(SCOPE_RE),
	dimensions: z.record(z.string(), z.union([z.string().max(512), z.boolean()])).optional(),
	measures: z.record(z.string(), z.number()).optional(),
	links: z
		.array(z.object({ rel: z.string().max(64), to: linkTarget }).strict())
		.max(16)
		.optional(),
	body_ref: z.string().nullable().optional(),
	meta: z
		.object({ fields: z.record(z.string(), fieldMeta).optional() })
		.loose()
		.optional(),
});

export type Emission = z.infer<typeof emissionSchema>;

/** ~16 KiB envelope cap + dimension/measure count caps (contract §2 bounds). */
const MAX_BYTES = 16 * 1024;
const MAX_FIELDS = 24;

export interface EmissionCheck {
	readonly ok: boolean;
	readonly emission?: Emission;
	readonly code?: string;
	readonly message?: string;
}

export function parseEmission(raw: unknown, rawBytes: number): EmissionCheck {
	if (rawBytes > MAX_BYTES)
		return {
			ok: false,
			code: "payload_too_large",
			message: `emission exceeds ${String(MAX_BYTES)} bytes`,
		};
	const parsed = emissionSchema.safeParse(raw);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return {
			ok: false,
			code: "invalid_emission",
			message: `${first.path.join(".")}: ${first.message}`,
		};
	}
	const e = parsed.data;
	if (e.dimensions && Object.keys(e.dimensions).length > MAX_FIELDS)
		return { ok: false, code: "invalid_emission", message: "too many dimensions" };
	if (e.measures && Object.keys(e.measures).length > MAX_FIELDS)
		return { ok: false, code: "invalid_emission", message: "too many measures" };
	return { ok: true, emission: e };
}
