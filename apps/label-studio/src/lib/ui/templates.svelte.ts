import type { Template } from "$lib/doc";

import { api, errorText } from "./client";

type Load =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; templates: Template[] }
	| { kind: "failed"; message: string };

/** The template list, fetched once per session and refreshed after edits. */
class Templates {
	load = $state<Load>({ kind: "idle" });

	get list(): Template[] {
		return this.load.kind === "ready" ? this.load.templates : [];
	}

	async ensure(): Promise<void> {
		if (this.load.kind === "idle") {
			await this.refresh();
		}
	}

	async refresh(): Promise<void> {
		if (this.load.kind !== "ready") {
			this.load = { kind: "loading" };
		}

		try {
			this.load = { kind: "ready", templates: await api.templates() };
		} catch (error) {
			this.load = { kind: "failed", message: errorText(error, "Templates failed to load") };
		}
	}
}

export const templates = new Templates();
