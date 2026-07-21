import { Schema } from "effect";

import { rejectUnknownKeys } from "../schema-conventions.ts";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);

const forecastSchema = Schema.Struct({
	strategy: Schema.optional(
		Schema.Literals([
			"auto",
			"linear",
			"drift",
			"moving_average",
			"exp_smoothing",
			"seasonal_naive",
		]),
	),
	horizon: Schema.optional(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
	window: Schema.optional(
		Schema.NullOr(
			Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 2, maximum: 100 })),
		),
	),
	alpha: Schema.optional(
		Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 1 }))),
	),
	season_length: Schema.optional(
		Schema.NullOr(
			Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 2, maximum: 366 })),
		),
	),
	confidence: Schema.optional(Schema.NullOr(Schema.Literals(["high", "medium", "low"]))),
	interval_pct: Schema.optional(
		Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
	),
}).annotate(rejectUnknownKeys);

// Panels tolerate renderer-specific extra keys (zod `.loose()` parity): the rest record keeps
// unknown keys in the decoded output instead of stripping or rejecting them.
const panelSpecSchema = Schema.StructWithRest(
	Schema.Struct({
		schema_version: Schema.Literal(2),
		type: Schema.Literals([
			"bar",
			"line",
			"stat",
			"table",
			"pie",
			"scatter",
			"gauge",
			"heatmap",
			"histogram",
			"insight",
			"text",
			"refusal",
		]),
		title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
		description: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000)))),
		query_ref: Schema.optional(
			Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
		),
		encoding: Schema.optional(Schema.NullOr(JsonRecord)),
		prose: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(100_000)))),
		refusal: Schema.optional(
			Schema.NullOr(
				Schema.Struct({
					reason: Schema.String.check(Schema.isMaxLength(2_000)),
					suggestions: Schema.optional(
						Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
							Schema.isMaxLength(12),
						),
					),
				}).annotate(rejectUnknownKeys),
			),
		),
		summary: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000)))),
		narrative: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_000)))),
		confidence: Schema.optional(Schema.NullOr(Schema.Literals(["high", "medium", "low"]))),
		recommendations: Schema.optional(
			Schema.NullOr(
				Schema.Array(Schema.String.check(Schema.isMaxLength(1_000))).check(Schema.isMaxLength(20)),
			),
		),
		suggestions: Schema.optional(
			Schema.NullOr(
				Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(20)),
			),
		),
		forecast: Schema.optional(Schema.NullOr(forecastSchema)),
		layout: Schema.optional(Schema.NullOr(JsonRecord)),
		live: Schema.optional(Schema.NullOr(JsonRecord)),
		render: Schema.optional(Schema.NullOr(JsonRecord)),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
).check(
	Schema.makeFilter((panel) => {
		const issues: Schema.FilterIssue[] = [];
		if (
			!["text", "refusal"].includes(panel.type) &&
			(typeof panel.query_ref !== "string" || panel.query_ref.length === 0)
		)
			issues.push({ path: ["query_ref"], issue: "data panels require query_ref" });
		if (panel.type === "text" && typeof panel.prose !== "string")
			issues.push({ path: ["prose"], issue: "text panels require prose" });
		if (panel.type === "refusal" && !panel.refusal)
			issues.push({ path: ["refusal"], issue: "refusal panels require refusal" });
		return issues;
	}),
);

export const selectedMarkSchema = Schema.Struct({
	element_kind: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	field: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
	value: Schema.optional(Schema.Unknown),
	datum: Schema.optional(JsonRecord),
	query_ref: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
	entity_ref: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
}).annotate(rejectUnknownKeys);

export const dashboardSaveSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	id: Schema.String.check(Schema.isUUID()),
	title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	scope: Schema.optional(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
	layout: Schema.optional(JsonRecord),
	panels: Schema.Array(panelSpecSchema).check(Schema.isMaxLength(60)),
	branch: Schema.optional(
		Schema.Struct({
			parent_dashboard_id: Schema.optional(
				Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
			),
			parent_question: Schema.optional(
				Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
			),
			filters: Schema.optional(JsonRecord),
			selected_mark: Schema.optional(Schema.NullOr(selectedMarkSchema)),
			assumptions: Schema.optional(
				Schema.Array(Schema.String.check(Schema.isMaxLength(1_000))).check(Schema.isMaxLength(50)),
			),
		}).annotate(rejectUnknownKeys),
	),
	time: Schema.optional(
		Schema.Struct({
			from: Schema.String.check(Schema.isMaxLength(100)),
			to: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))),
			refresh_s: Schema.optional(
				Schema.NullOr(
					Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 86_400 })),
				),
			),
		}).annotate(rejectUnknownKeys),
	),
}).annotate(rejectUnknownKeys);

export const renderRequestSchema = Schema.Struct({
	query_ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	panel: panelSpecSchema,
}).annotate(rejectUnknownKeys);

export const investigationBranchSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	id: Schema.String.check(Schema.isUUID()),
	title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	scope: Schema.optional(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
	parent_dashboard_id: Schema.NullOr(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	),
	parent_question: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
	panel: Schema.Struct({
		title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
		type: Schema.Literals(["bar", "line", "stat", "table", "scatter"]),
		query_ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	}).annotate(rejectUnknownKeys),
	selected_mark: Schema.Struct({
		element_kind: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
		field: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
		value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
	}).annotate(rejectUnknownKeys),
}).annotate(rejectUnknownKeys);
