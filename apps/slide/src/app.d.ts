// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
export interface SessionUser {
	id: string;
	name: string;
	email: string;
}

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user?: SessionUser;
		}
		interface PageData {
			user?: SessionUser | null;
		}
		// interface PageState {}
		// interface Platform {}
	}
}
