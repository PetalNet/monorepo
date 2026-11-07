import type { Job, JobStatus, StatusResponse } from "$lib/api";
import type { LabelDoc, Vars } from "$lib/doc";

import type { Printer, PrintOutcome } from "./printer.ts";
import type { Store } from "./store.ts";

export interface PrintSpec {
	title: string;
	templateId: string | null;
	doc: LabelDoc;
	/** The variables each page was rendered with. */
	rows: Vars[];
	pages: Uint8Array[];
	/** Tape used by the whole job, copies included. */
	lengthMm: number;
	copies: number;
	cut: boolean;
	chain: boolean;
	dryRun: boolean;
}

const KEEP_JOBS = 200;

/**
 * One FIFO worker. Jobs run strictly one after another on a promise chain whose links never reject,
 * so a failed job cannot stall the ones behind it.
 */
export class PrintQueue {
	readonly #store: Store;
	readonly #printer: Printer;
	readonly #now: () => Date;
	readonly #jobs = new Map<string, Job>();
	#current: Job | null = null;
	#tail: Promise<void> = Promise.resolve();

	constructor(deps: { store: Store; printer: Printer; now?: () => Date }) {
		this.#store = deps.store;
		this.#printer = deps.printer;
		this.#now = deps.now ?? (() => new Date());
	}

	submit(spec: PrintSpec): Job {
		const createdAt = this.#now().toISOString();
		const job: Job = {
			id: crypto.randomUUID(),
			historyId: crypto.randomUUID(),
			title: spec.title,
			status: "queued",
			pages: spec.pages.length,
			copies: spec.copies,
			lengthMm: spec.lengthMm,
			dryRun: spec.dryRun,
			createdAt,
		};

		this.#store.insertHistory(
			{
				id: job.historyId,
				createdAt,
				title: spec.title,
				templateId: spec.templateId,
				doc: spec.doc,
				rows: spec.rows,
				tapeMm: spec.doc.tapeMm,
				pages: job.pages,
				copies: spec.copies,
				lengthMm: spec.lengthMm,
				cut: spec.cut,
				chain: spec.chain,
				dryRun: spec.dryRun,
				status: "queued",
			},
			spec.pages,
		);

		this.#jobs.set(job.id, job);
		this.#forgetOldJobs();
		this.#tail = this.#tail.then(() => this.#run(job, spec));

		return { ...job };
	}

	jobs(): Job[] {
		return [...this.#jobs.values()].toReversed().map((job) => ({ ...job }));
	}

	job(id: string): Job | null {
		const job = this.#jobs.get(id);

		return job ? { ...job } : null;
	}

	snapshot(): StatusResponse["queue"] {
		const pending = [...this.#jobs.values()].filter((job) => job.status === "queued").length;

		return { pending, current: this.#current ? { ...this.#current } : null };
	}

	/** Resolves once every job submitted so far has finished. */
	drain(): Promise<void> {
		return this.#tail;
	}

	async #run(job: Job, spec: PrintSpec): Promise<void> {
		this.#current = job;
		this.#record(job, "printing");
		let outcome: PrintOutcome;

		try {
			outcome = await this.#attempt(spec);
		} catch (error) {
			outcome = {
				ok: false,
				message: `Print failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		job.finishedAt = this.#now().toISOString();

		if (outcome.ok) {
			this.#record(job, "done");
		} else {
			this.#record(job, "failed", outcome.message);
		}

		this.#current = null;
	}

	async #attempt(spec: PrintSpec): Promise<PrintOutcome> {
		if (spec.dryRun) {
			return { ok: true };
		}

		const printer = await this.#printer.status();

		if (printer.state !== "ready") {
			return { ok: false, message: printer.message };
		}

		if (printer.tape.widthMm !== spec.doc.tapeMm) {
			return {
				ok: false,
				message: `Wrong tape: designed for ${String(spec.doc.tapeMm)} mm, ${String(printer.tape.widthMm)} mm loaded`,
			};
		}

		return this.#printer.print(spec.pages, {
			copies: spec.copies,
			cut: spec.cut,
			chain: spec.chain,
			expectWidthMm: spec.doc.tapeMm,
		});
	}

	#record(job: Job, status: JobStatus, error?: string): void {
		job.status = status;

		if (error !== undefined) {
			job.error = error;
		}

		try {
			this.#store.setHistoryStatus(job.historyId, status, error);
		} catch (failure) {
			console.error("label-studio: could not record job status", failure);
		}
	}

	#forgetOldJobs(): void {
		for (const [id, job] of this.#jobs) {
			if (this.#jobs.size <= KEEP_JOBS) {
				break;
			}

			if (job.status === "done" || job.status === "failed") {
				this.#jobs.delete(id);
			}
		}
	}
}
