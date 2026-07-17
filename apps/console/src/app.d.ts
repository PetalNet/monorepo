declare global {
	interface ViteTypeOptions {
		strictImportMetaEnv: unknown;
	}

	interface ImportMetaEnv {
		readonly PUBLIC_CONSOLE_API_BASE?: string;
		readonly PUBLIC_CONSOLE_DATA_MODE?: "live" | "mock";
		readonly PUBLIC_GLITCHTIP_DSN?: string;
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
