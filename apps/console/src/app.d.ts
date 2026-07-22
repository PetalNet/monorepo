declare global {
	interface ViteTypeOptions {
		strictImportMetaEnv: unknown;
	}


	namespace App {
		interface Locals {
			session: import("better-auth").Session | null;
			user: import("better-auth").User | null;
			tier: "owner" | "operator" | "editor" | "viewer" | null;
		}
	}
}

export type AppTypesReady = true;
