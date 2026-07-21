/** Better Auth prefixes `.session_token`; the secure result is `__Host-console.session_token`. */
export function authCookiePrefix(baseUrl: string): string {
	return new URL(baseUrl).protocol === "https:" ? "__Host-console" : "console";
}
