import { editor } from "./editor.svelte";
import { importImage } from "./image";
import { createElement, newId } from "./model";

/** Decode an image file or pasted blob and add it sized to the band. */
export async function insertImage(blob: Blob): Promise<void> {
	const { gray, srcW, srcH } = await importImage(blob);
	const base = createElement(editor.doc, "rect");
	const band = editor.doc.orientation === "horizontal" ? base.h + base.y * 2 : base.w + base.x * 2;
	const along = Math.round((band * srcW) / srcH);
	const horizontal = editor.doc.orientation === "horizontal";

	editor.insert({
		id: newId(),
		kind: "image",
		x: horizontal ? base.x : 0,
		y: horizontal ? 0 : base.y,
		w: horizontal ? along : band,
		h: horizontal ? band : along,
		rotate: 0,
		invert: false,
		gray,
		srcW,
		srcH,
		mode: "dither",
		threshold: 128,
		fit: "contain",
	});
}
