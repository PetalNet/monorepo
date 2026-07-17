import { createHash } from "node:crypto";

import type { Emission } from "../emission.ts";

export interface DimensionDescriptor {
	type: "string" | "boolean";
	cardinality: "low" | "medium" | "high" | null;
}

export interface MeasureDescriptor {
	kind: "gauge" | "counter" | "delta" | "timestamp" | null;
	unit: string | null;
}

export interface JoinDescriptor {
	rel: string;
	to_kind: string;
}

export interface SemanticShape {
	dimensions: Record<string, DimensionDescriptor>;
	measures: Record<string, MeasureDescriptor>;
	joins: JoinDescriptor[];
}

export interface SemanticDrift {
	field: string;
	kind: "dimension_type" | "measure_kind" | "measure_unit";
	expected: string;
	observed: string;
}

export function deriveSemanticShape(e: Emission): SemanticShape {
	const dimensions: Record<string, DimensionDescriptor> = {};
	for (const [field, value] of Object.entries(e.dimensions ?? {})) {
		dimensions[field] = {
			type: typeof value === "boolean" ? "boolean" : "string",
			cardinality: e.meta?.fields?.[field]?.cardinality ?? null,
		};
	}
	const measures: Record<string, MeasureDescriptor> = {};
	for (const field of Object.keys(e.measures ?? {})) {
		measures[field] = {
			kind: e.meta?.fields?.[field]?.kind ?? null,
			unit: e.meta?.fields?.[field]?.unit ?? null,
		};
	}
	const joins = [...new Set((e.links ?? []).map((link) => `${link.rel}\u0000${link.to.kind}`))]
		.map((value) => {
			const [rel, to_kind] = value.split("\u0000");
			return { rel: rel, to_kind: to_kind };
		})
		.toSorted((a, b) => `${a.rel}:${a.to_kind}`.localeCompare(`${b.rel}:${b.to_kind}`));
	return { dimensions, measures, joins };
}

export function mergeSemanticShape(
	existing: SemanticShape,
	incoming: SemanticShape,
): { shape: SemanticShape; drift: SemanticDrift[] } {
	const dimensions = structuredClone(existing.dimensions);
	const measures = structuredClone(existing.measures);
	const drift: SemanticDrift[] = [];
	for (const [field, next] of Object.entries(incoming.dimensions)) {
		const current = dimensions[field];
		if (current.type !== next.type)
			drift.push({
				field,
				kind: "dimension_type",
				expected: current.type,
				observed: next.type,
			});
		else if (!current.cardinality && next.cardinality) current.cardinality = next.cardinality;
	}
	for (const [field, next] of Object.entries(incoming.measures)) {
		const current = measures[field];

		if (current.kind && next.kind && current.kind !== next.kind)
			drift.push({
				field,
				kind: "measure_kind",
				expected: current.kind,
				observed: next.kind,
			});
		else if (!current.kind && next.kind) current.kind = next.kind;
		if (current.unit && next.unit && current.unit !== next.unit)
			drift.push({
				field,
				kind: "measure_unit",
				expected: current.unit,
				observed: next.unit,
			});
		else if (!current.unit && next.unit) current.unit = next.unit;
	}
	const joinMap = new Map<string, JoinDescriptor>();
	for (const join of [...existing.joins, ...incoming.joins])
		joinMap.set(`${join.rel}\u0000${join.to_kind}`, join);
	return {
		shape: {
			dimensions,
			measures,
			joins: [...joinMap.values()].toSorted((a, b) =>
				`${a.rel}:${a.to_kind}`.localeCompare(`${b.rel}:${b.to_kind}`),
			),
		},
		drift,
	};
}

export function cardinalityClass(count: number): "low" | "medium" | "high" {
	if (count <= 20) return "low";
	if (count <= 1000) return "medium";
	return "high";
}

export function dimensionValueHash(value: string | boolean): string {
	return createHash("sha256").update(String(value)).digest("hex");
}

export function semanticDocument(type: string, shape: SemanticShape): string {
	const dimensions = Object.entries(shape.dimensions)
		.map(
			([name, descriptor]) =>
				`${name}:${descriptor.type}:${descriptor.cardinality ?? "unknown-cardinality"}`,
		)
		.join(" ");
	const measures = Object.entries(shape.measures)
		.map(
			([name, descriptor]) =>
				`${name}:${descriptor.kind ?? "unknown-kind"}:${descriptor.unit ?? "unitless"}`,
		)
		.join(" ");
	const joins = shape.joins.map((join) => `${join.rel}->${join.to_kind}`).join(" ");
	return `statistic ${type} dimensions ${dimensions || "none"} measures ${measures || "none"} joins ${joins || "none"}`;
}
