const AUTHENTIK_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Better Auth's generic OAuth parser only retains provider-mapped fields when `input` is true.
// The HTTP endpoints that could accept these fields from a user are disabled in auth.ts.
export const authentikUserFields = {
	authentikUsername: { type: "string", required: true, input: true },
	authentikGroups: { type: "string", required: true, input: true },
	authentikSubject: { type: "string", required: true, input: true },
} as const;

function authentikUsername(profile: Record<string, unknown>): string {
	const preferred =
		typeof profile.preferred_username === "string" ? profile.preferred_username : "";
	const email = typeof profile.email === "string" ? profile.email : "";
	const emailLocalpart = email.includes("@") ? email.slice(0, email.indexOf("@")) : "";
	const subject = typeof profile.sub === "string" ? profile.sub : "";
	return (
		[preferred, emailLocalpart, subject].find((value) => AUTHENTIK_USERNAME_PATTERN.test(value)) ??
		""
	);
}

export function authentikProfileUser(profile: Record<string, unknown>) {
	const username = authentikUsername(profile);
	const profileName = typeof profile.name === "string" ? profile.name.trim() : "";
	const groups = Array.isArray(profile.groups)
		? profile.groups.filter((group): group is string => typeof group === "string")
		: [];
	return {
		name: profileName || username,
		email: typeof profile.email === "string" ? profile.email : "",
		authentikUsername: username,
		authentikGroups: JSON.stringify(groups),
		authentikSubject: typeof profile.sub === "string" ? profile.sub : "",
	};
}
