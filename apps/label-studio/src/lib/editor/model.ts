/**
 * Pure document operations. Every edit the editor makes is one of these, applied to an immutable
 * `LabelDoc` and committed to the history as a whole snapshot.
 */
import {
	TAPES,
	mmToDots,
	type Box,
	type LabelDoc,
	type LabelElement,
	type Symbology,
	type TapeWidthMm,
} from "$lib/doc";

export const DEFAULT_FONT = "inter";

/** What the Add menu offers. Several entries share one element kind. */
export type AddKind =
	| "text"
	| "icon"
	| "line"
	| "rect"
	| "frame"
	| "rounded"
	| "qr"
	| "code128"
	| "datamatrix"
	| "ean13";

export function emptyDoc(tapeMm: TapeWidthMm = 12): LabelDoc {
	return {
		version: 1,
		tapeMm,
		orientation: "horizontal",
		length: { mode: "auto" },
		margin: { startMm: 2, endMm: 2 },
		invert: false,
		border: null,
		elements: [],
	};
}

/** Height of the printable band across the tape, in dots. */
export const bandDots = (doc: LabelDoc): number => TAPES[doc.tapeMm].pins;

/** The design frame for a resolved label length. */
export function frameSize(doc: LabelDoc, lengthDots: number): { w: number; h: number } {
	const band = bandDots(doc);

	return doc.orientation === "horizontal" ? { w: lengthDots, h: band } : { w: band, h: lengthDots };
}

/** The far edge of the content along the tape, where the next element goes. */
function contentEnd(doc: LabelDoc): number {
	const along = doc.orientation === "horizontal" ? "x" : "y";
	const size = along === "x" ? "w" : "h";
	let end = mmToDots(doc.margin.startMm);

	for (const element of doc.elements) {
		end = Math.max(end, element[along] + element[size] + mmToDots(1.5));
	}

	return end;
}

export const newId = (): string => crypto.randomUUID().slice(0, 8);

const CODE_DATA: Record<Symbology, string> = {
	qr: "https://example.com",
	code128: "LS-0001",
	datamatrix: "LS-0001",
	ean13: "590123412345",
};

/** A new element of the given kind, sized to the band and placed after the content. */
export function createElement(doc: LabelDoc, kind: AddKind): LabelElement {
	const band = bandDots(doc);
	const at = contentEnd(doc);
	const across = Math.round(band * 0.14);
	const place = (w: number, h: number, offset = 0): Box =>
		doc.orientation === "horizontal"
			? { x: at, y: offset, w, h }
			: { x: offset, y: at, w: h, h: w };
	const base = { id: newId(), rotate: 0 as const, invert: false };
	const line = Math.max(2, Math.round(band / 24));

	switch (kind) {
		case "text":
			return {
				...base,
				...place(band * 3, band),
				kind: "text",
				text: "Label",
				font: DEFAULT_FONT,
				size: band,
				bold: false,
				italic: false,
				align: "left",
				valign: "middle",
				lineHeight: 1.1,
				tracking: 0,
				fit: "fill",
				widthMode: "auto",
			};
		case "icon":
			return { ...base, ...place(band, band), kind: "icon", icon: "tag", stroke: 2 };
		case "line":
			return {
				...base,
				...place(band * 2, line * 3, Math.round(band / 2 - line * 1.5)),
				kind: "shape",
				shape: doc.orientation === "horizontal" ? "line-h" : "line-v",
				fill: false,
				stroke: line,
				radius: 0,
				dashed: false,
			};
		case "rect":
		case "rounded":
		case "frame": {
			const frame = kind === "frame";

			return {
				...base,
				...(frame
					? place(Math.max(band * 3, at), band)
					: place(band * 2, band - across * 2, across)),
				...(frame && doc.orientation === "horizontal" ? { x: 0 } : {}),
				...(frame && doc.orientation === "vertical" ? { y: 0 } : {}),
				kind: "shape",
				shape: "rect",
				fill: false,
				stroke: line,
				radius: kind === "rect" ? 0 : Math.round(band / 5),
				dashed: false,
			};
		}
		case "qr":
		case "datamatrix":
			return {
				...base,
				...place(band, band),
				kind: "code",
				symbology: kind,
				data: CODE_DATA[kind],
				ecc: "M",
				showText: false,
			};
		case "code128":
		case "ean13":
			return {
				...base,
				...place(band * 3, band),
				kind: "code",
				symbology: kind,
				data: CODE_DATA[kind],
				ecc: "M",
				showText: true,
			};
	}
}

export function addElement(doc: LabelDoc, element: LabelElement): LabelDoc {
	return { ...doc, elements: [...doc.elements, element] };
}

export function updateElement<E extends LabelElement>(
	doc: LabelDoc,
	id: string,
	patch: Partial<E>,
): LabelDoc {
	return {
		...doc,
		elements: doc.elements.map((element) =>
			element.id === id ? { ...element, ...patch } : element,
		),
	};
}

export function mapElements(
	doc: LabelDoc,
	ids: readonly string[],
	update: (element: LabelElement) => LabelElement,
): LabelDoc {
	const wanted = new Set(ids);

	return {
		...doc,
		elements: doc.elements.map((element) => (wanted.has(element.id) ? update(element) : element)),
	};
}

/** Move the unlocked elements among `ids` by a delta in dots. */
export function moveBy(doc: LabelDoc, ids: readonly string[], dx: number, dy: number): LabelDoc {
	return mapElements(doc, ids, (element) =>
		element.locked ? element : { ...element, x: element.x + dx, y: element.y + dy },
	);
}

export function removeElements(doc: LabelDoc, ids: readonly string[]): LabelDoc {
	const gone = new Set(ids);

	return { ...doc, elements: doc.elements.filter((element) => !gone.has(element.id)) };
}

/** Copies of `ids`, offset a little and stacked above the originals. Returns the new ids. */
export function duplicate(doc: LabelDoc, ids: readonly string[]): { doc: LabelDoc; ids: string[] } {
	const wanted = new Set(ids);
	const offset = Math.max(4, Math.round(bandDots(doc) / 8));
	const copies = doc.elements
		.filter((element) => wanted.has(element.id))
		.map((element) => ({
			...element,
			id: newId(),
			locked: false,
			x: element.x + offset,
			y: element.y + (doc.orientation === "vertical" ? offset : 0),
		}));

	return {
		doc: { ...doc, elements: [...doc.elements, ...copies] },
		ids: copies.map((copy) => copy.id),
	};
}

export type LayerMove = "forward" | "backward" | "front" | "back";

/** Change paint order. Index 0 is the bottom layer. */
export function reorder(doc: LabelDoc, ids: readonly string[], move: LayerMove): LabelDoc {
	const wanted = new Set(ids);
	const picked = doc.elements.filter((element) => wanted.has(element.id));
	const rest = doc.elements.filter((element) => !wanted.has(element.id));

	if (move === "front") {
		return { ...doc, elements: [...rest, ...picked] };
	}

	if (move === "back") {
		return { ...doc, elements: [...picked, ...rest] };
	}

	const elements = [...doc.elements];
	const step = move === "forward" ? 1 : -1;
	const order = move === "forward" ? [...elements.keys()].toReversed() : [...elements.keys()];

	for (const index of order) {
		const element = elements[index];
		const target = index + step;
		const neighbour = elements[target] as LabelElement | undefined;

		if (!wanted.has(element.id) || !neighbour || wanted.has(neighbour.id)) {
			continue;
		}

		elements[index] = neighbour;
		elements[target] = element;
	}

	return { ...doc, elements };
}

/** Move `id` to an absolute layer index (0 = bottom), for drag-reordering the layers list. */
export function moveToIndex(doc: LabelDoc, id: string, index: number): LabelDoc {
	const element = doc.elements.find((candidate) => candidate.id === id);

	if (!element) {
		return doc;
	}

	const rest = doc.elements.filter((candidate) => candidate.id !== id);
	const at = Math.max(0, Math.min(rest.length, index));

	return { ...doc, elements: [...rest.slice(0, at), element, ...rest.slice(at)] };
}

export type AlignEdge = "left" | "center" | "right" | "top" | "middle" | "bottom";

const ALIGN_AXIS: Record<AlignEdge, { axis: "x" | "y"; at: 0 | 0.5 | 1 }> = {
	left: { axis: "x", at: 0 },
	center: { axis: "x", at: 0.5 },
	right: { axis: "x", at: 1 },
	top: { axis: "y", at: 0 },
	middle: { axis: "y", at: 0.5 },
	bottom: { axis: "y", at: 1 },
};

/** The bounding box of several boxes. */
export function unionBox(boxes: readonly Box[]): Box | null {
	if (boxes.length === 0) {
		return null;
	}

	const x = Math.min(...boxes.map((box) => box.x));
	const y = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.w));
	const bottom = Math.max(...boxes.map((box) => box.y + box.h));

	return { x, y, w: right - x, h: bottom - y };
}

/**
 * Align one element to the frame, or several to their shared bounding box. `boxes` are the resolved
 * boxes from the renderer (auto-width text reports its real width).
 */
export function align(
	doc: LabelDoc,
	ids: readonly string[],
	edge: AlignEdge,
	frame: { w: number; h: number },
	boxes: Readonly<Partial<Record<string, Box>>>,
): LabelDoc {
	const { axis, at } = ALIGN_AXIS[edge];
	const size = axis === "x" ? "w" : "h";
	const resolved = (element: LabelElement): Box => boxes[element.id] ?? element;
	const targets = doc.elements.filter((element) => ids.includes(element.id) && !element.locked);
	const reference =
		ids.length > 1 ? unionBox(targets.map(resolved)) : { x: 0, y: 0, w: frame.w, h: frame.h };

	if (!reference) {
		return doc;
	}

	return mapElements(
		doc,
		targets.map((element) => element.id),
		(element) => {
			const box = resolved(element);
			const position = reference[axis] + (reference[size] - box[size]) * at;

			return { ...element, [axis]: Math.round(position) };
		},
	);
}

/**
 * Lay the design out for a different cassette: every element scales by the ratio of the printable
 * bands, so a 12 mm design keeps its composition on 9 mm.
 */
export function retape(doc: LabelDoc, tapeMm: TapeWidthMm): LabelDoc {
	if (tapeMm === doc.tapeMm) {
		return doc;
	}

	const ratio = TAPES[tapeMm].pins / TAPES[doc.tapeMm].pins;
	const scale = (value: number): number => Math.round(value * ratio);
	const thin = (value: number): number => (value === 0 ? 0 : Math.max(1, scale(value)));

	return {
		...doc,
		tapeMm,
		border: doc.border && {
			stroke: thin(doc.border.stroke),
			radius: scale(doc.border.radius),
			inset: scale(doc.border.inset),
		},
		elements: doc.elements.map((element) => {
			const box = {
				x: scale(element.x),
				y: scale(element.y),
				w: scale(element.w),
				h: scale(element.h),
			};

			if (element.kind === "text") {
				return { ...element, ...box, size: Math.max(4, scale(element.size)) };
			}

			if (element.kind === "shape") {
				return { ...element, ...box, stroke: thin(element.stroke), radius: scale(element.radius) };
			}

			return { ...element, ...box };
		}),
	};
}

/** The display name for an element in the layers list. */
export function elementLabel(element: LabelElement): string {
	if (element.name) {
		return element.name;
	}

	switch (element.kind) {
		case "text":
			return element.text.split("\n")[0].trim() || "Empty text";
		case "icon":
			return element.icon;
		case "image":
			return "Image";
		case "code":
			return SYMBOLOGY_NAMES[element.symbology];
		case "shape":
			return SHAPE_NAMES[element.shape];
	}
}

export const SYMBOLOGY_NAMES: Record<Symbology, string> = {
	qr: "QR code",
	code128: "Code 128",
	datamatrix: "Data Matrix",
	ean13: "EAN-13",
};

const SHAPE_NAMES = {
	rect: "Rectangle",
	ellipse: "Ellipse",
	"line-h": "Line",
	"line-v": "Line",
} as const;
