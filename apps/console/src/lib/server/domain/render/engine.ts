import type { QueryResult } from "../query/structured.ts";
import type {
	ForecastSpec,
	MaterializedPanel,
	PanelSpecV2,
	PanelType,
	RenderArtifact,
	VegaLiteSpec,
} from "./types.ts";

const PALETTE = [
	"#00d1ff",
	"#ff8a00",
	"#7c5cff",
	"#22c55e",
	"#ff4d6d",
	"#facc15",
	"#14b8a6",
	"#f97316",
	"#a855f7",
	"#06b6d4",
];

function rowsAsObjects(result: QueryResult): Record<string, unknown>[] {
	return result.rows.map((row) =>
		Object.fromEntries(result.columns.map((column, index) => [column.name, row[index] ?? null])),
	);
}

function isNumericType(type: string): boolean {
	return type === "number" || /int|float|double|numeric|decimal|real/i.test(type);
}

function looksTemporal(name: string, values: readonly unknown[]): boolean {
	if (/^(ts|time|date|bucket|received_at)$/i.test(name)) return true;
	const present = values.filter((value) => value !== null && value !== undefined).slice(0, 20);
	return (
		present.length > 0 &&
		present.every(
			(value) =>
				typeof value === "string" &&
				(/^\d{4}-\d{2}(?:-\d{2})?/.test(value) || !Number.isNaN(Date.parse(value))),
		)
	);
}

function selectPanelType(result: QueryResult): {
	type: PanelType;
	x?: string;
	y?: string;
	value?: string;
	reason: string;
} {
	const data = rowsAsObjects(result);
	if (data.length === 0)
		return { type: "table", reason: "empty result uses an honest table state" };
	const numeric = result.columns.filter((column) => isNumericType(column.type));
	const dimensions = result.columns.filter((column) => !isNumericType(column.type));
	const temporal = dimensions.find((column) =>
		looksTemporal(
			column.name,
			data.map((row) => row[column.name]),
		),
	);
	if (result.columns.length === 1 && numeric[0])
		return { type: "stat", value: numeric[0].name, reason: "one numeric measure" };
	if (temporal && numeric[0])
		return {
			type: "line",
			x: temporal.name,
			y: numeric[0].name,
			reason: "temporal dimension × numeric measure",
		};
	if (dimensions[0] && numeric[0]) {
		const cardinality = new Set(data.map((row) => row[dimensions[0].name])).size;
		if (cardinality <= 20)
			return {
				type: "bar",
				x: dimensions[0].name,
				y: numeric[0].name,
				reason: `categorical dimension × measure (${String(cardinality)} categories)`,
			};
		return {
			type: "table",
			reason: `categorical cardinality ${String(cardinality)} exceeds chart threshold`,
		};
	}
	if (numeric.length >= 2)
		return {
			type: "scatter",
			x: numeric[0].name,
			y: numeric[1].name,
			reason: "two numeric measures",
		};
	return { type: "table", reason: "no safe dimension × measure chart mapping" };
}

function encodingField(panel: PanelSpecV2, key: string): string | undefined {
	const value = panel.encoding?.[key];
	return typeof value === "string" ? value : undefined;
}

interface Forecasted {
	values: Record<string, unknown>[];
	strategy: string;
	lower: string;
	upper: string;
	xType: "temporal" | "quantitative";
}

function forecastValues(
	values: Record<string, unknown>[],
	x: string,
	y: string,
	spec: ForecastSpec,
): Forecasted | null {
	const unsorted = values
		.map((row, index) => ({ row, index, x: row[x], y: Number(row[y]) }))
		.filter((point) => Number.isFinite(point.y));
	if (unsorted.length < 3) return null;
	const dateCandidates = unsorted.map((point) =>
		typeof point.x === "string" ? Date.parse(point.x) : Number.NaN,
	);
	const numericAxis = unsorted.every((point) => Number.isFinite(Number(point.x)));
	const dateAxis = !numericAxis && dateCandidates.every(Number.isFinite);
	if (!dateAxis && !numericAxis) return null;
	const points = [...unsorted].toSorted((a, b) => {
		const left = dateAxis ? Date.parse(String(a.x)) : Number(a.x);
		const right = dateAxis ? Date.parse(String(b.x)) : Number(b.x);
		return left - right || a.index - b.index;
	});
	const parsedDates = points.map((point) =>
		typeof point.x === "string" ? Date.parse(point.x) : Number.NaN,
	);
	const horizon = Math.min(
		100,
		Math.max(1, Math.trunc(spec.horizon ?? Math.min(12, points.length))),
	);
	const requested = spec.strategy ?? "auto";
	const seasonLength = Math.max(2, Math.trunc(spec.season_length ?? 0));
	const ys = points.map((point) => point.y);
	const mean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
	const variance =
		ys.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, ys.length - 1);
	const stdDev = Math.sqrt(variance);
	let strategy = requested;
	if (strategy === "auto")
		strategy = seasonLength > 1 && points.length >= seasonLength * 2 ? "seasonal_naive" : "linear";
	if (strategy === "seasonal_naive" && (seasonLength < 2 || points.length < seasonLength))
		strategy = "drift";
	const window = Math.min(points.length, Math.max(2, Math.trunc(spec.window ?? 3)));
	const alpha = Math.min(1, Math.max(0.01, spec.alpha ?? 0.35));
	const first = ys[0];
	const last = ys.at(-1)!;
	let smooth = first;
	for (const value of ys.slice(1)) smooth = alpha * value + (1 - alpha) * smooth;
	const n = ys.length;
	const meanT = (n - 1) / 2;
	const covariance = ys.reduce((sum, value, index) => sum + (index - meanT) * (value - mean), 0);
	const varianceT = ys.reduce((sum, _value, index) => sum + (index - meanT) ** 2, 0);
	const slope = varianceT === 0 ? 0 : covariance / varianceT;
	const residuals = ys.map((value, index) => value - (mean + slope * (index - meanT)));
	const residualStd = Math.sqrt(
		residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, residuals.length - 2),
	);
	const confidenceMultiplier = { high: 1.96, medium: 1.64, low: 1.28 }[spec.confidence ?? "medium"];
	const interval =
		spec.interval_pct !== null && spec.interval_pct !== undefined
			? (Math.abs(last) * Math.max(0, spec.interval_pct)) / 100
			: Math.max(residualStd, stdDev * 0.1) * confidenceMultiplier;
	const xNumbers = dateAxis ? parsedDates : points.map((point) => Number(point.x));
	const steps = xNumbers.slice(1).map((value, index) => value - xNumbers[index]);
	const positive = steps.filter((step) => step > 0).toSorted((a, b) => a - b);
	const step = positive[Math.floor(positive.length / 2)] ?? 1;
	const actual = points.map((point) => ({ ...point.row, __series: "actual" }));
	const predicted: Record<string, unknown>[] = [];
	for (let offset = 1; offset <= horizon; offset += 1) {
		let yValue: number;
		switch (strategy) {
			case "drift":
				yValue = last + ((last - first) / Math.max(1, n - 1)) * offset;
				break;
			case "moving_average":
				yValue = ys.slice(-window).reduce((sum, value) => sum + value, 0) / window;
				break;
			case "exp_smoothing":
				yValue = smooth;
				break;
			case "seasonal_naive":
				yValue = ys[(n + offset - 1 - seasonLength) % n] ?? last;
				break;
			default:
				yValue = mean + slope * (n + offset - 1 - meanT);
		}
		const xValue = xNumbers.at(-1)! + step * offset;
		predicted.push({
			[x]: dateAxis ? new Date(xValue).toISOString() : xValue,
			[y]: yValue,
			forecast_lower: yValue - interval * Math.sqrt(offset),
			forecast_upper: yValue + interval * Math.sqrt(offset),
			__series: "forecast",
		});
	}
	return {
		values: [...actual, ...predicted],
		strategy,
		lower: "forecast_lower",
		upper: "forecast_upper",
		xType: dateAxis ? "temporal" : "quantitative",
	};
}

function baseSpec(values: Record<string, unknown>[], title: string): VegaLiteSpec {
	return {
		$schema: "https://vega.github.io/schema/vega-lite/v6.json",
		data: { values },
		title,
		background: "transparent",
		config: {
			view: { stroke: "transparent" },
			axis: { gridColor: "rgba(128,128,128,0.18)" },
			range: { category: PALETTE },
		},
	};
}

function vegaFor(
	panel: PanelSpecV2,
	result: QueryResult,
): { spec: VegaLiteSpec | null; forecast: string | null } {
	const values = rowsAsObjects(result);
	if (
		values.length === 0 ||
		panel.type === "table" ||
		panel.type === "stat" ||
		panel.type === "text" ||
		panel.type === "refusal"
	)
		return { spec: null, forecast: null };
	const x = encodingField(panel, "x") ?? result.columns[0]?.name;
	const y = encodingField(panel, "y") ?? result.columns[1]?.name;
	if (!x || !y) return { spec: null, forecast: null };
	const color = encodingField(panel, "color") ?? encodingField(panel, "group_by");
	const tooltip = result.columns.map(({ name }) => ({ field: name }));
	const base = baseSpec(values, panel.title);
	if (panel.type === "line" && panel.forecast) {
		const forecast = forecastValues(values, x, y, panel.forecast);
		if (forecast)
			return {
				forecast: forecast.strategy,
				spec: {
					...baseSpec(forecast.values, panel.title),
					layer: [
						{
							transform: [{ filter: "datum.__series === 'forecast'" }],
							mark: { type: "area", opacity: 0.16 },
							encoding: {
								x: { field: x, type: forecast.xType },
								y: { field: forecast.lower, type: "quantitative" },
								y2: { field: forecast.upper },
							},
						},
						{
							mark: { type: "line", point: true },
							encoding: {
								x: { field: x, type: forecast.xType },
								y: { field: y, type: "quantitative" },
								color: {
									field: "__series",
									type: "nominal",
									scale: { range: [PALETTE[0], PALETTE[1]] },
								},
								strokeDash: {
									field: "__series",
									type: "nominal",
									scale: {
										domain: ["actual", "forecast"],
										range: [
											[1, 0],
											[6, 4],
										],
									},
								},
								tooltip,
							},
						},
					],
				},
			};
	}
	const mark =
		panel.type === "bar"
			? "bar"
			: panel.type === "scatter"
				? "point"
				: panel.type === "histogram"
					? "bar"
					: "line";
	return {
		forecast: null,
		spec: {
			...base,
			mark: { type: mark, ...(mark === "line" ? { point: true } : {}) },
			encoding: {
				x: {
					field: x,
					type:
						panel.type === "line"
							? "temporal"
							: panel.type === "scatter"
								? "quantitative"
								: "nominal",
					sort: panel.type === "bar" ? "-y" : undefined,
				},
				y: { field: y, type: "quantitative" },
				...(color ? { color: { field: color, type: "nominal" } } : {}),
				tooltip,
			},
		},
	};
}

export function materializePanel(input: PanelSpecV2, result: QueryResult): MaterializedPanel {
	const requestedFields = input.encoding ?? {};
	const known = new Set(result.columns.map(({ name }) => name));
	const requestedX = encodingField(input, "x");
	const requestedY = encodingField(input, "y");
	const selected =
		input.type === "line" &&
		input.forecast &&
		requestedX &&
		requestedY &&
		known.has(requestedX) &&
		known.has(requestedY)
			? {
					type: "line" as const,
					x: requestedX,
					y: requestedY,
					reason: "explicit forecast request with valid x/y fields",
				}
			: selectPanelType(result);
	const validFields = Object.fromEntries(
		Object.entries(requestedFields).filter(([, value]) =>
			Array.isArray(value)
				? value.every((field) => typeof field === "string" && known.has(field))
				: typeof value !== "string" || known.has(value),
		),
	);
	const panel: PanelSpecV2 = {
		...input,
		type: selected.type,
		query_ref: result.query_ref,
		encoding:
			Object.keys(validFields).length > 0
				? validFields
				: selected.type === "stat"
					? { value: selected.value }
					: selected.type === "table"
						? { columns: result.columns.map(({ name }) => name) }
						: { x: selected.x, y: selected.y },
	};
	const generated = vegaFor(panel, result);
	const render: RenderArtifact = {
		schema_version: 1,
		renderer: generated.spec ? "vega-lite" : "native",
		spec: generated.spec,
		data_query_ref: result.query_ref,
		selection_reason: selected.reason,
		forecast_strategy: generated.forecast,
	};
	panel.render = render;
	return { schema_version: 1, panel, result, render };
}
