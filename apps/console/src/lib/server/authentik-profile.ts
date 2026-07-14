const AUTHENTIK_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function authentikUsername(profile: Record<string, unknown>): string {
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
