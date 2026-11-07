import type { LabelDoc, RenderOptions } from "$lib/doc";
import { renderLabel } from "$lib/render";
import { browserFonts } from "$lib/render/fonts";

interface Request {
	id: number;
	doc: LabelDoc;
	options: RenderOptions;
}

async function handle({ id, doc, options }: Request): Promise<void> {
	try {
		const result = await renderLabel(doc, options, browserFonts);
		const transfer = [
			result.frame.data.buffer,
			...(result.raster ? [result.raster.data.buffer] : []),
		];

		postMessage({ id, result }, { transfer });
	} catch (error) {
		postMessage(
			{ id, error: error instanceof Error ? error.message : String(error) },
			{ transfer: [] },
		);
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * A dedicated worker only hears from the page that created it, so there is no origin to check;
 * anything that is not a render request is dropped rather than rendered or answered.
 */
function isRequest(data: unknown): data is Request {
	return (
		isRecord(data) &&
		typeof data.id === "number" &&
		isRecord(data.doc) &&
		Array.isArray(data.doc.elements) &&
		isRecord(data.options)
	);
}

addEventListener("message", (event: MessageEvent<unknown>) => {
	if (isRequest(event.data)) {
		void handle(event.data);
	}
});
