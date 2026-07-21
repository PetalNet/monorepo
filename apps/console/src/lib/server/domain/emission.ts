// The L1 canonical emission shape (contract §2; `SignalEmissionSchema` in
// src/lib/contracts/entities.ts pins the served projection), validated at the ingest door. This is
// the one envelope that is both a bus signal and a lake statistic.

import { Cause, Exit, Schema } from "effect";

import { ISO_DATETIME_OFFSET_RE, rejectUnknownKeys } from "./schema-conventions.ts";
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

const actionTarget = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(512),
	Schema.makeFilter(
		(value: string) =>
			isSafeEmissionAction(value) || "action must be an internal route or HTTPS URL",
	),
);

const SUBJECT_KINDS = [
	"agent",
	"host",
	"service",
	"task",
	"card",
	"item",
	"user",
	"session",
	"other",
] as const;

const linkTarget = Schema.Struct({
	kind: Schema.Literals(SUBJECT_KINDS),
	id: Schema.String.check(Schema.isMaxLength(256)),
}).annotate(rejectUnknownKeys);

const fieldMeta = Schema.Struct({
	unit: Schema.optional(Schema.String.check(Schema.isMaxLength(32))),
	kind: Schema.optional(Schema.Literals(["gauge", "counter", "delta", "timestamp"])),
	cardinality: Schema.optional(Schema.Literals(["low", "medium", "high"])),
}).annotate(rejectUnknownKeys);

// additionalProperties: true on the wire (dual-role envelope, Rule 1 exemption) — but we validate
// the known shape strictly enough to keep the lake honest, then pass unknown keys through in `meta`.
const emissionSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	id: Schema.String.check(Schema.isUUID()),
	type: Schema.String.check(Schema.isPattern(TYPE_RE), Schema.isMaxLength(128)),
	ts: Schema.String.check(Schema.isPattern(ISO_DATETIME_OFFSET_RE)),
	source: Schema.Struct({
		service: Schema.String.check(Schema.isMaxLength(64)),
		host: Schema.optional(Schema.NullOr(Schema.String)),
		agent: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(HANDLE_RE)))),
	}),
	subject: Schema.String.check(Schema.isMaxLength(256)),
	subject_kind: Schema.optional(Schema.NullOr(Schema.Literals(SUBJECT_KINDS))),
	severity: Schema.Literals(SEVERITIES),
	action: Schema.optional(Schema.NullOr(actionTarget)),
	task_id: Schema.optional(Schema.NullOr(Schema.Number.check(Schema.isInt()))),
	scope: Schema.String.check(Schema.isPattern(SCOPE_RE)),
	dimensions: Schema.optional(
		Schema.Record(
			Schema.String,
			Schema.Union([Schema.String.check(Schema.isMaxLength(512)), Schema.Boolean]),
		),
	),
	measures: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
	links: Schema.optional(
		Schema.Array(
			Schema.Struct({ rel: Schema.String.check(Schema.isMaxLength(64)), to: linkTarget }).annotate(
				rejectUnknownKeys,
			),
		).check(Schema.isMaxLength(16)),
	),
	body_ref: Schema.optional(Schema.NullOr(Schema.String)),
	meta: Schema.optional(
		Schema.StructWithRest(
			Schema.Struct({ fields: Schema.optional(Schema.Record(Schema.String, fieldMeta)) }),
			[Schema.Record(Schema.String, Schema.Unknown)],
		),
	),
});

export type Emission = typeof emissionSchema.Type;

/** ~16 KiB envelope cap + dimension/measure count caps (contract §2 bounds). */
const MAX_BYTES = 16 * 1024;
const MAX_FIELDS = 24;

export interface EmissionCheck {
	readonly ok: boolean;
	readonly emission?: Emission;
	readonly code?: string;
	readonly message?: string;
}

const decodeEmission = Schema.decodeUnknownExit(emissionSchema);

export function parseEmission(raw: unknown, rawBytes: number): EmissionCheck {
	if (rawBytes > MAX_BYTES)
		return {
			ok: false,
			code: "payload_too_large",
			message: `emission exceeds ${String(MAX_BYTES)} bytes`,
		};
	const parsed = decodeEmission(raw);
	if (Exit.isFailure(parsed)) {
		const failure = Cause.squash(parsed.cause);
		return {
			ok: false,
			code: "invalid_emission",
			message: failure instanceof Error ? failure.message : String(failure),
		};
	}
	const e = parsed.value;
	if (e.dimensions && Object.keys(e.dimensions).length > MAX_FIELDS)
		return { ok: false, code: "invalid_emission", message: "too many dimensions" };
	if (e.measures && Object.keys(e.measures).length > MAX_FIELDS)
		return { ok: false, code: "invalid_emission", message: "too many measures" };
	return { ok: true, emission: e };
}
