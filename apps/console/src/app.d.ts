declare global {
	namespace App {
		interface Locals {
			session: import("better-auth").Session | null;
			user: import("better-auth").User | null;
			tier: "owner" | "viewer" | null;
		}
	}
}

export type AppTypesReady = true;
