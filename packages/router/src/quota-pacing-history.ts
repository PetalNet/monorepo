import type { Builder, Burn } from "./quota-pacing.ts";

interface HistoricalBurn extends Burn {
	scope: string;
	window: string;
	builder: Builder;
	until: number;
}

const until = Date.UTC(2026, 11, 7);
const codex = "codex";
const gemini = "google-ai:gemini";
const argon = "google-ai:argon";
const google = "google-ai";

function observation(
	scope: string,
	window: string,
	builder: Builder,
	perHour: number,
	perRun: number,
	samples: number,
): HistoricalBurn {
	return { scope, window, builder, until, perHour, perRun, hoursPerRun: perRun / perHour, samples };
}

// Account-wide quota deltas during intervals dominated by this model and effort.
// Method, sample counts and limitations are in QUOTA-PACING.md.
export const BOOTSTRAP_BURN = [
	observation(
		"prolite",
		"codex:7d",
		{ pool: codex, model: "gpt-6.2-sol", effort: "high" },
		1.915,
		2.75,
		20,
	),
	observation(
		"prolite",
		"codex:7d",
		{ pool: codex, model: "gpt-6.1-sol", effort: "medium" },
		1.402,
		0.667,
		9,
	),
	observation(
		google,
		"google-ai:gemini-models:7d",
		{ pool: gemini, model: "gemini-4-neon", effort: "high" },
		38.986,
		4.25,
		9,
	),
	observation(
		google,
		"google-ai:gemini-models:5h",
		{ pool: gemini, model: "gemini-4-neon", effort: "high" },
		107.925,
		13,
		8,
	),
	observation(
		google,
		"google-ai:gemini-4-argon:7d",
		{ pool: argon, model: "gemini-4-argon", effort: "high" },
		60.871,
		5.786,
		8,
	),
	observation(
		google,
		"google-ai:gemini-models:5h",
		{ pool: argon, model: "gemini-4-argon", effort: "high" },
		5.857,
		0.5,
		6,
	),
];
