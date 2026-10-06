import type { Session, User } from "better-auth/types";

import type { PersonPrincipal } from "#lib/server/actors/authority.ts";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			actor: PersonPrincipal | null;
			session: Session | null;
			user: User | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}
