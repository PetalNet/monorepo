import type { PrinterState } from "$lib/api";
import { tapeGeometry, type LabelDoc } from "$lib/doc";
import { afterEach, describe, expect, it } from "vitest";

import type { Printer, PrintOptions, PrintOutcome } from "./printer.ts";
import { PrintQueue, type PrintSpec } from "./queue.ts";
import { Store } from "./store.ts";

const doc = (tapeMm: LabelDoc["tapeMm"]): LabelDoc => ({
	version: 1,
	tapeMm,
	orientation: "horizontal",
	length: { mode: "auto" },
	margin: { startMm: 2, endMm: 2 },
	invert: false,
	border: null,
	elements: [],
});

const spec = (overrides: Partial<PrintSpec> = {}): PrintSpec => ({
	title: "Test",
	templateId: null,
	doc: doc(12),
	rows: [{}],
	pages: [Uint8Array.of(1, 2, 3)],
	lengthMm: 10,
	copies: 1,
	cut: true,
	chain: false,
	dryRun: false,
	...overrides,
});

/** Records every call; each print waits a tick so overlapping jobs would interleave. */
function fakePrinter(state: PrinterState, outcomes: PrintOutcome[] = []) {
	const log: string[] = [];
	const prints: { pages: number; options: PrintOptions }[] = [];
	const printer: Printer = {
		status() {
			log.push("status");

			return Promise.resolve(state);
		},
		async print(pages, options) {
			log.push("print:start");

			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			prints.push({ pages: pages.length, options });
			log.push("print:end");

			return outcomes.shift() ?? { ok: true };
		},
	};

	return { printer, log, prints };
}

const ready: PrinterState = { state: "ready", tape: tapeGeometry(12) };

let store: Store;

afterEach(() => {
	store.close();
});

describe("PrintQueue", () => {
	it("runs jobs one at a time, in order, and a failure does not block the next", async () => {
		store = new Store(":memory:");
		const { printer, log } = fakePrinter(ready, [{ ok: false, message: "Cutter jam" }]);
		const queue = new PrintQueue({ store, printer });

		const first = queue.submit(spec({ title: "first" }));
		const second = queue.submit(spec({ title: "second" }));

		expect(queue.snapshot().pending).toBe(2);
		await queue.drain();

		expect(log).toEqual([
			"status",
			"print:start",
			"print:end",
			"status",
			"print:start",
			"print:end",
		]);

		expect(queue.job(first.id)).toMatchObject({ status: "failed", error: "Cutter jam" });
		expect(queue.job(second.id)?.status).toBe("done");

		expect(store.getHistory(first.historyId)).toMatchObject({
			status: "failed",
			error: "Cutter jam",
		});

		expect(store.getHistory(second.historyId)?.status).toBe("done");
		expect(queue.jobs().map((job) => job.title)).toEqual(["second", "first"]);
	});

	it("refuses a design for another tape width without sending it", async () => {
		store = new Store(":memory:");
		const { printer, prints } = fakePrinter(ready);
		const queue = new PrintQueue({ store, printer });

		const job = queue.submit(spec({ doc: doc(24) }));

		await queue.drain();

		expect(prints).toHaveLength(0);

		expect(queue.job(job.id)).toMatchObject({
			status: "failed",
			error: "Wrong tape: designed for 24 mm, 12 mm loaded",
		});
	});

	it("fails with the printer's message when it is not ready", async () => {
		store = new Store(":memory:");

		const { printer, prints } = fakePrinter({
			state: "offline",
			message: "Print server unreachable",
		});
		const queue = new PrintQueue({ store, printer });

		const job = queue.submit(spec());

		await queue.drain();

		expect(prints).toHaveLength(0);

		expect(queue.job(job.id)).toMatchObject({
			status: "failed",
			error: "Print server unreachable",
		});
	});

	it("records a dry run as done without touching the printer", async () => {
		store = new Store(":memory:");
		const { printer, log } = fakePrinter(ready);
		const queue = new PrintQueue({ store, printer });

		const job = queue.submit(spec({ dryRun: true, pages: [Uint8Array.of(7), Uint8Array.of(8)] }));

		await queue.drain();

		expect(log).toEqual([]);
		expect(queue.job(job.id)?.status).toBe("done");
		expect(store.historyPages(job.historyId)).toEqual([Uint8Array.of(7), Uint8Array.of(8)]);
	});

	it("passes copies, cut, chain and the designed width to the printer", async () => {
		store = new Store(":memory:");
		const { printer, prints } = fakePrinter(ready);
		const queue = new PrintQueue({ store, printer });

		queue.submit(
			spec({ copies: 3, cut: false, chain: true, pages: [Uint8Array.of(1), Uint8Array.of(2)] }),
		);

		await queue.drain();

		expect(prints).toEqual([
			{ pages: 2, options: { copies: 3, cut: false, chain: true, expectWidthMm: 12 } },
		]);
	});
});
