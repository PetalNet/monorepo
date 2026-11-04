import type { LabelDoc, RenderOptions, RenderResult } from "$lib/doc";

/** Loads font bytes for a family/style. The browser fetches them; the server reads files. */
export interface FontSource {
	load(file: string): Promise<ArrayBuffer>;
}

/**
 * Draw a label document. The browser preview and the server's print path call this
 * same function, so the preview in "print" mode is byte-for-byte the printed raster.
 */
export function renderLabel(
	_doc: LabelDoc,
	_options: RenderOptions,
	_fonts: FontSource,
): Promise<RenderResult> {
	throw new Error("renderLabel: not implemented yet");
}
