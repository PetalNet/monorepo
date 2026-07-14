export type AuthGateDecision = "allow" | "home" | { redirectTo: string };

/** Pure policy shared by the server hook and its regression tests. */
export function authGateDecision(
	pathname: string,
	search: string,
	hasSession: boolean,
): AuthGateDecision {
	if (hasSession) return pathname === "/login" ? "home" : "allow";
	if (pathname === "/login") return "allow";
	return { redirectTo: `/login?returnTo=${encodeURIComponent(pathname + search)}` };
}
