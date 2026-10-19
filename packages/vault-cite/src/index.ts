/* oxlint-disable eslint/no-await-in-loop -- Sequential processing bounds resource use and preserves pacing, redirect and retry order. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { parse } from "csv-parse/sync";
import { z } from "zod";

import { CaptureError, DiskFull, normalize } from "./model.ts";
import type { Job } from "./model.ts";
import { Network } from "./network.ts";
import { resolveSource } from "./resolver.ts";
import type { Store } from "./store.ts";
import { diskGuard } from "./store.ts";
export { Store } from "./store.ts";
export { sourceType, sourceSchema } from "./model.ts";

export class Cite {
	readonly store: Store;
	readonly network: Network;
	constructor(store: Store, network = new Network(store)) {
		this.store = store;
		this.network = network;
	}
	async work(ref?: string, limit = 100) {
		const counts = {
			saved: 0,
			inaccessible: 0,
			failed: 0,
			retried: 0,
			processed: 0,
			stopped: false,
		};

		try {
			for (let i = 0; i < limit; i++) {
				diskGuard(this.store.root);
				const job = this.store.claim(ref);

				if (!job) {
					break;
				}

				try {
					const capture = await resolveSource(job.ref, this.network);
					const source = this.store.save(capture);

					this.store.finish(job, "SAVED", null, source.id);
					counts.saved++;
				} catch (error) {
					if (error instanceof DiskFull) {
						this.store.finish(job, "QUEUED", "Disk guard", null, 60_000);

						throw error;
					}

					const failure =
						error instanceof CaptureError
							? error
							: new CaptureError(
									error instanceof TypeError || (error instanceof Error && "code" in error)
										? "RETRY"
										: "FAILED",
									"Capture or extraction error; no source committed",
								);
					const retry = failure.kind === "RETRY" && job.attempts < 4;
					const state: Job["state"] = retry
						? "QUEUED"
						: failure.kind === "INACCESSIBLE"
							? "INACCESSIBLE"
							: "FAILED";

					this.store.finish(
						job,
						state,
						failure.message,
						null,
						retry ? Math.max(failure.retryAfter, 30_000 * 2 ** (job.attempts - 1)) : 0,
					);

					if (retry) {
						counts.retried++;
					} else if (state === "INACCESSIBLE") {
						counts.inaccessible++;
					} else {
						counts.failed++;
					}
				}

				counts.processed++;
			}
		} catch (error) {
			if (error instanceof DiskFull) {
				counts.stopped = true;
			} else {
				throw error;
			}
		}

		return counts;
	}
	async add(ref: string) {
		const canonical = normalize(ref);

		this.store.enqueue(canonical);
		const counts = await this.work(canonical, 1);

		return { counts, job: this.store.job(canonical), source: this.store.get(canonical) };
	}
	async remember(text: string, ref: string) {
		// A failed capture cannot create a memory with a URL masquerading as PRIMARY evidence.
		const result = await this.add(ref);

		if (!result.source) {
			throw new CaptureError("FAILED", "Memory not written: primary capture is incomplete");
		}

		const id = createHash("sha256")
			.update(JSON.stringify([text, result.source.id]))
			.digest("hex");

		this.store.db
			.prepare("INSERT OR IGNORE INTO memories VALUES(?,?,?)")
			.run(id, text, result.source.id);

		return { id, source: result.source.id, link: `source:: [[${result.source.id}]]` };
	}
	backfill(csv: string, phase: "papers" | "rest") {
		const rows = z
			.array(
				z.object({ citation_key: z.string(), example_raw: z.string(), primary_scope: z.string() }),
			)
			.parse(
				parse(readFileSync(csv, "utf8"), { columns: true, bom: true, skip_empty_lines: true }),
			);
		const counts = { selected: 0, enqueued: 0, existing: 0, invalid: 0 };

		for (const row of rows) {
			const paper =
				row.primary_scope === "1" &&
				(/^(?:arxiv:|doi:)/i.test(row.citation_key) || row.citation_key.endsWith(".pdf"));

			if ((phase === "papers") !== paper) {
				continue;
			}

			counts.selected++;

			try {
				const ref = normalize(
					/^(?:doi:|arxiv:)/i.test(row.citation_key) ? row.citation_key : row.example_raw,
				);

				if (this.store.enqueue(ref)) {
					counts.enqueued++;
				} else {
					counts.existing++;
				}
			} catch {
				counts.invalid++;
			}
		}

		return counts;
	}
}
