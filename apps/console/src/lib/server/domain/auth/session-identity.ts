import { isConsoleTier, type ConsoleTier } from "./tier-lanes.ts";

export type BetterAuthSessionIdentity =
	| {
			readonly kind: "authentik";
			readonly username: string;
			readonly groups: readonly string[];
			readonly subject: string;
			readonly sessionId: string;
	  }
	| {
			readonly kind: "app";
			readonly userId: string;
			readonly tier: ConsoleTier;
			readonly sessionId: string;
	  };

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || codePoint === 0x7f;
	});
}

export function parseBetterAuthIdentity(
	user: Record<string, unknown>,
	sessionId = "",
): BetterAuthSessionIdentity | null {
	const userId = user["id"];
	const tier = user["tier"];
	if (typeof userId === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(userId) && isConsoleTier(tier))
		return { kind: "app", userId, tier, sessionId };
	const username = user["authentikUsername"];
	const encodedGroups = user["authentikGroups"];
	const subject = user["authentikSubject"];
	if (typeof username !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) return null;
	if (
		typeof subject !== "string" ||
		subject.length === 0 ||
		subject.length > 255 ||
		hasControlCharacter(subject)
	)
		return null;
	if (typeof encodedGroups !== "string") return null;
	try {
		const groups = JSON.parse(encodedGroups) as unknown;
		if (
			!Array.isArray(groups) ||
			groups.length === 0 ||
			groups.length > 128 ||
			groups.some(
				(group) => typeof group !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,127}$/.test(group),
			) ||
			new Set(groups).size !== groups.length
		)
			return null;
		return { kind: "authentik", username, groups, subject, sessionId };
	} catch {
		return null;
	}
}
