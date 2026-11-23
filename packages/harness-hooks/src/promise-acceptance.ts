export interface Acceptance {
	requested: string;
	preserved: string[];
	checks: Record<string, string | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function updateAcceptance(previous: Acceptance | null, patch: unknown): Acceptance {
	if (
		!isRecord(patch) ||
		Object.keys(patch).some((key) => !["requested", "preserved", "checks"].includes(key))
	) {
		throw new Error("acceptance expects requested, preserved and checks");
	}
	const requested = patch["requested"] ?? previous?.requested;
	const preserved = patch["preserved"] ?? [];
	const checks = patch["checks"] ?? {};
	if (
		!isText(requested) ||
		!Array.isArray(preserved) ||
		!preserved.every(isText) ||
		!isRecord(checks)
	) {
		throw new Error("acceptance needs a goal, a list of retained constraints and named checks");
	}
	const next = { ...previous?.checks };
	for (const [check, evidence] of Object.entries(checks)) {
		if (!check.trim() || (evidence !== null && !isText(evidence))) {
			throw new Error("each check needs a name and evidence or null");
		}
		Object.defineProperty(next, check, {
			value: evidence,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	if (Object.keys(next).length === 0) {
		throw new Error("acceptance needs at least one check");
	}
	return {
		requested,
		preserved: [...new Set([...(previous?.preserved ?? []), ...preserved])],
		checks: next,
	};
}
