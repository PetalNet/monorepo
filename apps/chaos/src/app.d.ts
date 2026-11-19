import type { Store } from "#lib/server/store.ts";

declare global {
	namespace App {
		interface Locals {
			store: Store;
		}
	}
}
