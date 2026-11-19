export const CODEX_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
export const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof CODEX_EFFORTS)[number] | (typeof AGY_EFFORTS)[number] | "default";

const AGY_MODEL_EFFORTS: Record<string, readonly Effort[]> = {
	"gemini-4-neon": ["low", "medium", "high", "xhigh"],
	"gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
	"gemini-4-argon": ["low", "medium", "high"],
	"gemini-3.8-flash": ["low", "medium", "high"],
	"gemini-3-8-flash": ["low", "medium", "high"],
	"claude-opus-5-5": ["low", "medium", "high"],
	"claude-sonnet-5-5": ["low", "medium", "high"],
	"gpt-oss-120b": ["medium"],
};

/** Agy variants come from `agy models`; fixed/unknown models retain their catalog effort. */
export function supportedEfforts(
	provider: string,
	model: string,
	catalogEffort: Effort = "default",
): readonly Effort[] {
	if (provider === "codex") {
		return CODEX_EFFORTS;
	}

	if (provider === "claude") {
		return AGY_EFFORTS;
	}

	if (provider === "gemini" || provider.startsWith("agy-")) {
		return AGY_MODEL_EFFORTS[model] ?? [catalogEffort];
	}

	return [catalogEffort];
}
