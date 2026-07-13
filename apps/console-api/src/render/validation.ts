import { z } from "zod";

const forecastSchema = z
	.object({
		strategy: z
			.enum(["auto", "linear", "drift", "moving_average", "exp_smoothing", "seasonal_naive"])
			.optional(),
		horizon: z.number().int().min(1).max(100).optional(),
		window: z.number().int().min(2).max(100).nullable().optional(),
		alpha: z.number().min(0.01).max(1).nullable().optional(),
		season_length: z.number().int().min(2).max(366).nullable().optional(),
		confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
		interval_pct: z.number().min(0).max(1_000).nullable().optional(),
	})
	.strict();

const panelSpecSchema = z
	.object({
		schema_version: z.literal(2),
		type: z.enum([
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
		title: z.string().min(1).max(200),
		description: z.string().max(2_000).nullable().optional(),
		query_ref: z.string().min(1).max(100).nullable().optional(),
		encoding: z.record(z.string(), z.unknown()).nullable().optional(),
		prose: z.string().max(100_000).nullable().optional(),
		refusal: z
			.object({
				reason: z.string().max(2_000),
				suggestions: z.array(z.string().max(500)).max(12).optional(),
			})
			.strict()
			.nullable()
			.optional(),
		summary: z.string().max(4_000).nullable().optional(),
		narrative: z.string().max(8_000).nullable().optional(),
		confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
		recommendations: z.array(z.string().max(1_000)).max(20).nullable().optional(),
		suggestions: z.array(z.string().max(500)).max(20).nullable().optional(),
		forecast: forecastSchema.nullable().optional(),
		layout: z.record(z.string(), z.unknown()).nullable().optional(),
		live: z.record(z.string(), z.unknown()).nullable().optional(),
		render: z.record(z.string(), z.unknown()).nullable().optional(),
	})
	.passthrough()
	.superRefine((panel, context) => {
		if (
			!["text", "refusal"].includes(panel.type) &&
			(typeof panel.query_ref !== "string" || panel.query_ref.length === 0)
		)
			context.addIssue({
				code: "custom",
				path: ["query_ref"],
				message: "data panels require query_ref",
			});
		if (panel.type === "text" && typeof panel.prose !== "string")
			context.addIssue({ code: "custom", path: ["prose"], message: "text panels require prose" });
		if (panel.type === "refusal" && !panel.refusal)
			context.addIssue({
				code: "custom",
				path: ["refusal"],
				message: "refusal panels require refusal",
			});
	});

export const selectedMarkSchema = z
	.object({
		element_kind: z.string().min(1).max(100),
		field: z.string().max(200).optional(),
		value: z.unknown().optional(),
		datum: z.record(z.string(), z.unknown()).optional(),
		query_ref: z.string().max(100).optional(),
		entity_ref: z.string().max(500).optional(),
	})
	.strict();

export const dashboardSaveSchema = z
	.object({
		schema_version: z.literal(1),
		id: z.string().uuid(),
		title: z.string().trim().min(1).max(200),
		scope: z.string().trim().min(1).max(500).optional(),
		layout: z.record(z.string(), z.unknown()).optional(),
		panels: z.array(panelSpecSchema).max(60),
		branch: z
			.object({
				parent_dashboard_id: z.string().max(100).nullable().optional(),
				parent_question: z.string().max(2_000).nullable().optional(),
				filters: z.record(z.string(), z.unknown()).optional(),
				selected_mark: selectedMarkSchema.nullable().optional(),
				assumptions: z.array(z.string().max(1_000)).max(50).optional(),
			})
			.strict()
			.optional(),
		time: z
			.object({
				from: z.string().max(100),
				to: z.string().max(100).nullable().optional(),
				refresh_s: z.number().int().min(1).max(86_400).nullable().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export const renderRequestSchema = z
	.object({ query_ref: z.string().min(1).max(100), panel: panelSpecSchema })
	.strict();
