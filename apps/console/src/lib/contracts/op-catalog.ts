// Effect Schema for the canonical op catalog (docs/contracts/ops.json). `$lib/api/ops` decodes the
// imported catalog through this schema so the module fails loudly on catalog drift instead of
// shipping a silently mismatched command surface. Browser-safe (data-only).
import { Schema } from "effect";

import { LaneSchema } from "./entities.ts";
import { rejectUnknownKeys } from "./schema-conventions.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

const OpAuthzSchema = Schema.Struct({
	rule: Schema.Literals(["own", "grant", "own_or_grant", "read", "scope_visible", "self"]),
	relation: Schema.optional(Schema.String),
	scope_any: Schema.optional(Schema.Array(Schema.String)),
}).annotate(rejectUnknownKeys);

const OpEntrySchema = Schema.StructWithRest(
	Schema.Struct({
		op: Schema.String.check(Schema.isMinLength(1)),
		lane: LaneSchema,
		authz: OpAuthzSchema,
		executor: Schema.String.check(Schema.isMinLength(1)),
		// Inline, fully dereferenced JSON-schema for the op's arguments (the catalog is
		// self-contained since Phase 4 removed the sibling schema files).
		args: JsonObject,
		emits: Schema.Array(Schema.String),
		testable: Schema.Literals(["disposable", "dry-run-only", "live-canary"]),
		confirm: Schema.optional(Schema.Literals(["soft", "typed-name"])),
		undo: Schema.optional(Schema.Boolean),
		human_only: Schema.optional(Schema.Boolean),
		requires_reason: Schema.optional(Schema.Boolean),
		destructive: Schema.optional(Schema.Boolean),
		effect: Schema.optional(Schema.String),
		lineage: Schema.optional(Schema.String),
		phase: Schema.optional(Schema.Number),
	}),
	[JsonObject],
);

export const OpCatalogSchema = Schema.StructWithRest(
	Schema.Struct({
		schema_version: Schema.Literal(2),
		lanes: Schema.Array(LaneSchema).check(Schema.isMinLength(1), Schema.isUnique()),
		ops: Schema.Array(OpEntrySchema).check(Schema.isMinLength(1)),
	}),
	[JsonObject],
);
