import type { McpPrincipal } from "$lib/server/mcp-oauth";
import type { Session, User } from "better-auth/types";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			mcpPrincipal: McpPrincipal | null;
			session: Session | null;
			user: User | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}
