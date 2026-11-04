import type { Job, PrintRequest } from "$lib/api";

import { api, errorText } from "./client";
import { printerStatus } from "./printer.svelte";

/** A print the user started in this tab, followed until it finishes. */
export interface TrackedJob {
	job: Job;
	request: PrintRequest;
	/** Set when following the job itself failed (server gone), not when the print failed. */
	lost?: string;
}

const POLL_MS = 600;

class Jobs {
	tracked = $state<TrackedJob[]>([]);
	/** The job row in the shell; dismissed rows stay in history. */
	visible = $state<string | null>(null);

	get current(): TrackedJob | null {
		return this.tracked.find((entry) => entry.job.id === this.visible) ?? null;
	}

	/** Queue a print. Throws an Error with the server's message when it is refused. */
	async print(request: PrintRequest, show = true): Promise<TrackedJob> {
		const job = await api.print(request);

		return this.follow(job, request, show);
	}

	/**
	 * Track a job. `show` puts it in the shell's job banner; a sheet that already shows the job
	 * passes false and calls `show()` when it closes.
	 */
	follow(job: Job, request: PrintRequest, show = true): TrackedJob {
		const entry: TrackedJob = { job, request };

		this.tracked = [entry, ...this.tracked].slice(0, 20);

		if (show) {
			this.visible = job.id;
		}

		this.#poll(job.id);

		return entry;
	}

	retry(entry: TrackedJob): Promise<TrackedJob> {
		return this.print(entry.request);
	}

	show(id: string): void {
		this.visible = id;
	}

	dismiss(): void {
		this.visible = null;
	}

	find(id: string): TrackedJob | undefined {
		return this.tracked.find((entry) => entry.job.id === id);
	}

	#update(id: string, patch: Partial<TrackedJob>): void {
		this.tracked = this.tracked.map((entry) =>
			entry.job.id === id ? { ...entry, ...patch } : entry,
		);
	}

	/** Follow one job until it settles; five failed polls in a row and it is reported lost. */
	#poll(id: string, misses = 0): void {
		const entry = this.find(id);

		if (!entry || entry.job.status === "done" || entry.job.status === "failed") {
			void printerStatus.refresh();

			return;
		}

		setTimeout(() => {
			void this.#check(id, misses);
		}, POLL_MS);
	}

	async #check(id: string, misses: number): Promise<void> {
		try {
			this.#update(id, { job: await api.job(id), lost: undefined });
			this.#poll(id);
		} catch (error) {
			if (misses + 1 >= 5) {
				this.#update(id, { lost: errorText(error, "Lost track of this job") });
			} else {
				this.#poll(id, misses + 1);
			}
		}
	}
}

export const jobs = new Jobs();
