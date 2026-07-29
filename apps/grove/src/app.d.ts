// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			session: import("better-auth/types").Session | null;
			user: import("better-auth/types").User | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export type AppTypesReady = true;
