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

addEventListener("message", (event: MessageEvent<Request>) => {
	void handle(event.data);
});
