const usernamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const groupPattern = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,127}$/;

export const authentikUserFields = {
	authentikUsername: { type: "string", required: true, input: true },
	authentikGroups: { type: "string", required: true, input: true },
	authentikSubject: { type: "string", required: true, input: true },
} as const;

export const validatedGroups = (value: unknown) => {
	if (!Array.isArray(value) || value.length > 128) return [];
	const groups = value.filter(
		(group): group is string => typeof group === "string" && groupPattern.test(group),
	);
	return new Set(groups).size === groups.length ? groups : [];
};

export const inheritedTier = (groups: readonly string[]) =>
	groups.some((group) => group === "authentik Admins" || group === "admin")
		? ("owner" as const)
		: ("viewer" as const);

export const authentikProfileUser = (profile: Record<string, unknown>) => {
	const email = typeof profile.email === "string" ? profile.email : "";
	const candidates = [
		typeof profile.preferred_username === "string" ? profile.preferred_username : "",
		email.includes("@") ? email.slice(0, email.indexOf("@")) : "",
		typeof profile.sub === "string" ? profile.sub : "",
	];
	const username = candidates.find((candidate) => usernamePattern.test(candidate)) ?? "";
	const name = typeof profile.name === "string" ? profile.name.trim() : "";
	return {
		name: name || username,
		email,
		authentikUsername: username,
		authentikGroups: JSON.stringify(validatedGroups(profile.groups)),
		authentikSubject: typeof profile.sub === "string" ? profile.sub : "",
	};
};
