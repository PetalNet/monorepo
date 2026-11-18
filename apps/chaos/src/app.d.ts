import type { Store } from "$lib/server/store";

declare global {
	namespace App {
		interface Locals {
			store: Store;
		}
	}
}
