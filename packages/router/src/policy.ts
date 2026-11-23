import type { ServiceName } from "@petalnet/harness-hooks/quota-sources";

import { hasCredentials } from "./adapters.ts";

export type DataClass = "public" | "sensitive" | "parcs";

export function parseDataClass(value: string): DataClass | undefined {
	if (value === "confidential") {
		return "parcs";
	}

	return value === "public" || value === "sensitive" || value === "parcs" ? value : undefined;
}

export function vendorOf(model: string): string {
	if (/^(?:gpt|o\d|codex)/u.test(model)) {
		return "openai";
	}

	if (/^(?:gemini|gemma)/u.test(model)) {
		return "google";
	}

	return /(?:claude|opus|sonnet|haiku|fable)/u.test(model) ? "anthropic" : "other";
}

/**
 * "Parcs Labs" is Parker's own LLC, not the Bridgeton PARCS job, so it does not count. A brief
 * carrying a credential is sensitive whatever the flag says; the class only ever rises.
 */
export function effectiveDataClass(flag: DataClass, brief: string): DataClass {
	if (flag === "parcs" || /\bBridgeton\b|\bPARCS\b(?!\s*Labs)/iu.test(brief)) {
		return "parcs";
	}

	return hasCredentials(brief) ? "sensitive" : flag;
}

export interface Pool {
	id: string;
	plan: string;
	/** Quota source that reports this pool's windows; absent when nothing meters it. */
	service?: ServiceName;
	/** Quota limit ids this pool draws on. The pacer reserves budget on each of them. */
	windows: string[];
	host: { name: string; country: "us" | "cn" | "unknown" };
	trainsOnData: "yes" | "no" | "unknown";
	trainingSource?: string;
	explicitOnly?: true;
}

const GOOGLE = { name: "Google", country: "us" } as const;
const GOOGLE_POOL = {
	plan: "google-ai",
	service: "google-ai",
	host: GOOGLE,
	trainsOnData: "yes",
} as const;
const CLAUDE_POOL = {
	plan: "claude",
	service: "claude",
	host: { name: "Anthropic", country: "us" },
	trainsOnData: "no",
	trainingSource: "Parker 2026-11-19",
	explicitOnly: true,
} as const;

export const POOLS: Pool[] = [
	{
		...GOOGLE_POOL,
		id: "google-ai:gemini",
		windows: ["google-ai:gemini-models:5h", "google-ai:gemini-models:7d"],
	},
	// Unproven whether Argon also spends the Gemini 5h window; assume it does until a probe says otherwise.
	{
		...GOOGLE_POOL,
		id: "google-ai:argon",
		windows: ["google-ai:gemini-4-argon:7d", "google-ai:gemini-models:5h"],
	},
	{
		...GOOGLE_POOL,
		id: "google-ai:claude-gpt",
		windows: ["google-ai:claude-and-gpt-models:5h", "google-ai:claude-and-gpt-models:7d"],
	},
	{
		id: "codex",
		plan: "codex",
		service: "codex",
		windows: ["codex:5h", "codex:7d"],
		host: { name: "OpenAI", country: "us" },
		trainsOnData: "no",
		trainingSource: "Parker 2026-11-19",
	},
	{ ...CLAUDE_POOL, id: "claude", windows: ["claude:5h", "claude:7d"] },
	{ ...CLAUDE_POOL, id: "claude:fable", windows: ["claude:5h", "claude:7d", "claude:fable"] },
];

type Effort = "none" | "low" | "medium" | "high" | "default";

export interface Target {
	model: string;
	effort: Effort;
	pool: Pool;
}

const EFFORT_SUFFIX = /-(none|low|medium|high|xhigh|max|ultra)$/u;

export function isModelSpec(input: string): boolean {
	const id = /^([a-z0-9][a-z0-9.-]*)(?::[^:\s]*)?$/u.exec(input)?.[1];

	return id !== undefined && resolveTarget(id.replace(EFFORT_SUFFIX, "")) !== undefined;
}

export function resolveTarget(input: string, preferNativeClaude = false): Target | undefined {
	const [id, requested, extra] = input.split(":");

	if (!id || extra !== undefined || !/^[a-z0-9][a-z0-9.-]*$/u.test(id)) {
		return undefined;
	}

	const suffix = EFFORT_SUFFIX.exec(id)?.[1];
	const model = suffix ? id.slice(0, -suffix.length - 1) : id;
	const nativeClaude = /^(?:claude-)?(?:opus|sonnet|haiku|fable)(?:-|$)/u.test(model);
	let poolId: string;

	if (
		model === "gpt-oss-120b" ||
		(!preferNativeClaude && (model === "claude-opus-5-5" || model === "claude-sonnet-5-5"))
	) {
		poolId = "google-ai:claude-gpt";
	} else if (model.startsWith("gemini-")) {
		poolId = model.startsWith("gemini-4-argon") ? "google-ai:argon" : "google-ai:gemini";
	} else if (nativeClaude) {
		poolId = /^(?:claude-)?fable/u.test(model) ? "claude:fable" : "claude";
	} else if (/^(?:gpt-|codex(?:-|$)|o\d)/u.test(model)) {
		poolId = "codex";
	} else {
		return undefined;
	}

	const pool = POOLS.find(({ id: key }) => key === poolId);
	const defaultEffort =
		poolId === "codex" ||
		poolId.startsWith("claude") ||
		poolId === "google-ai:claude-gpt" ||
		/^gemini-(?:4-(?:neon|hydrogen|argon)|3[.-]8-flash)$/u.test(model)
			? "medium"
			: "default";
	const effort = requested ?? suffix ?? defaultEffort;

	if (
		!pool ||
		(suffix && requested && suffix !== requested) ||
		(effort !== "low" &&
			effort !== "medium" &&
			effort !== "high" &&
			effort !== "default" &&
			effort !== "none") ||
		(effort === "none" && poolId !== "codex") ||
		(effort === "default" && defaultEffort !== "default") ||
		(model === "gpt-oss-120b" && effort !== "medium")
	) {
		return undefined;
	}

	return { model, effort, pool };
}

export function classRefusal(
	target: Target,
	dataClass: DataClass,
	allowClaude: boolean,
): string | undefined {
	const { pool } = target;

	if (dataClass === "parcs" && pool.plan !== "claude") {
		return "parcs brief: claude plan only";
	}

	if (dataClass !== "public" && (pool.host.country !== "us" || pool.trainsOnData !== "no")) {
		return "sensitive brief: requires a US host with a verified training opt-out";
	}

	if (pool.explicitOnly && dataClass !== "parcs" && !allowClaude) {
		return "claude plan is explicit-use only (use --allow-claude)";
	}

	if (pool.id === "claude:fable" && Date.now() < Date.parse("2026-11-24T10:00:00Z")) {
		return "Fable blocked until 2026-11-24T10:00:00Z";
	}

	return undefined;
}
