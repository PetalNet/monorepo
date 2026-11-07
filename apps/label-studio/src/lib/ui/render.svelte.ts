/**
 * Every on-screen label comes from `renderLabel`, the function the server prints with. Renders run
 * on the main thread until one takes longer than a frame budget, then move to a Web Worker for the
 * rest of the session.
 */
import type { Bitmap, LabelDoc, RenderOptions, RenderResult } from "$lib/doc";
import { renderLabel } from "$lib/render";
import { browserFonts } from "$lib/render/fonts";

import RenderWorker from "./render.worker.ts?worker";

const BUDGET_MS = 8;

type Reply = { id: number; result: RenderResult } | { id: number; error: string };

class Renderer {
	/** Last measured main-thread render time, for the report and the switch. */
	lastMainMs = $state<number | null>(null);
	useWorker = $state(false);
	#worker: Worker | null = null;
	#nextId = 0;
	readonly #waiting = new Map<
		number,
		{ resolve: (result: RenderResult) => void; reject: (error: Error) => void }
	>();
	#slowStreak = 0;
	#warm = false;
	#inFlight = 0;

	async render(doc: LabelDoc, options: RenderOptions): Promise<RenderResult> {
		if (this.useWorker) {
			return this.#inWorker(doc, options);
		}

		this.#inFlight += 1;
		const solo = this.#inFlight === 1;
		const started = performance.now();
		const result = await renderLabel($state.snapshot(doc), options, browserFonts).finally(() => {
			this.#inFlight -= 1;
		});
		const took = performance.now() - started;

		/*
		 * Only a render that ran alone measures frame cost: concurrent renders (a gallery of
		 * thumbnails) interleave at their awaits and each one's wall time includes the others.
		 * The first render also loads fonts, so it is skipped.
		 */
		if (this.#warm && solo && this.#inFlight === 0) {
			this.lastMainMs = took;
			this.#slowStreak = took > BUDGET_MS ? this.#slowStreak + 1 : 0;

			if (this.#slowStreak >= 2 && typeof Worker !== "undefined") {
				this.useWorker = true;
			}
		}

		this.#warm = true;

		return result;
	}

	#inWorker(doc: LabelDoc, options: RenderOptions): Promise<RenderResult> {
		if (!this.#worker) {
			this.#worker = new RenderWorker();

			this.#worker.addEventListener("message", (event: MessageEvent<Reply>) => {
				const waiter = this.#waiting.get(event.data.id);

				this.#waiting.delete(event.data.id);

				if ("error" in event.data) {
					waiter?.reject(new Error(event.data.error));
				} else {
					waiter?.resolve(event.data.result);
				}
			});
		}

		const id = this.#nextId++;
		const worker = this.#worker;

		return new Promise((resolve, reject) => {
			this.#waiting.set(id, { resolve, reject });
			worker.postMessage({ id, doc: $state.snapshot(doc), options }, []);
		});
	}
}

const renderer = new Renderer();

/**
 * A render that follows changing inputs: at most one render per animation frame, one in flight at a
 * time, and the latest request always wins.
 */
export class LiveRender {
	result = $state.raw<RenderResult | null>(null);
	error = $state<string | null>(null);
	#pending: { doc: LabelDoc; options: RenderOptions } | null = null;
	#busy = false;
	#frame = 0;

	request(doc: LabelDoc, options: RenderOptions): void {
		this.#pending = { doc, options };

		if (this.#frame === 0) {
			this.#frame = requestAnimationFrame(() => {
				this.#frame = 0;
				void this.#pump();
			});
		}
	}

	async #pump(): Promise<void> {
		if (this.#busy || !this.#pending) {
			return;
		}

		const { doc, options } = this.#pending;

		this.#pending = null;
		this.#busy = true;

		try {
			this.result = await renderer.render(doc, options);
			this.error = null;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.#busy = false;
		}

		const next = this.#pending as { doc: LabelDoc; options: RenderOptions } | null;

		if (next) {
			this.request(next.doc, next.options);
		}
	}

	dispose(): void {
		cancelAnimationFrame(this.#frame);
		this.#pending = null;
	}
}

/** Paint an ink bitmap onto a canvas: ink in `color`, paper transparent so the tape shows through. */
export function paint(
	canvas: HTMLCanvasElement,
	bitmap: Bitmap,
	color: [number, number, number],
): void {
	if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
	}

	const context = canvas.getContext("2d");

	if (!context || bitmap.width === 0 || bitmap.height === 0) {
		return;
	}

	const image = context.createImageData(bitmap.width, bitmap.height);
	const pixels = image.data;
	const [r, g, b] = color;

	for (let index = 0; index < bitmap.data.length; index++) {
		const offset = index * 4;

		pixels[offset] = r;
		pixels[offset + 1] = g;
		pixels[offset + 2] = b;
		pixels[offset + 3] = bitmap.data[index];
	}

	context.putImageData(image, 0, 0);
}
