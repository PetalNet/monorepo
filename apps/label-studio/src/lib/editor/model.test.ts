import { TAPES, type LabelDoc, type ShapeElement, type TextElement } from "$lib/doc";
import { describe, expect, it } from "vitest";

import {
	align,
	createElement,
	duplicate,
	emptyDoc,
	moveBy,
	moveToIndex,
	removeElements,
	reorder,
	retape,
	updateElement,
} from "./model";

function withElements(count: number): LabelDoc {
	let doc = emptyDoc(12);

	for (let index = 0; index < count; index++) {
		doc = {
			...doc,
			elements: [...doc.elements, { ...createElement(doc, "rect"), id: `e${String(index)}` }],
		};
	}

	return doc;
}

const ids = (doc: LabelDoc): string[] => doc.elements.map((element) => element.id);

describe("createElement", () => {
	it("sizes text to the printable band of the tape", () => {
		const text = createElement(emptyDoc(9), "text") as TextElement;

		expect(text.kind).toBe("text");
		expect(text.h).toBe(TAPES[9].pins);
		expect(text.size).toBe(TAPES[9].pins);
	});

	it("places a new element after the existing content", () => {
		const doc = withElements(1);
		const next = createElement(doc, "icon");

		expect(next.x).toBeGreaterThan(doc.elements[0].x + doc.elements[0].w);
	});

	it("makes frames span the whole band", () => {
		const frame = createElement(emptyDoc(12), "frame") as ShapeElement;

		expect(frame).toMatchObject({ kind: "shape", shape: "rect", x: 0, y: 0, h: TAPES[12].pins });
	});

	it("maps each code kind to its symbology", () => {
		for (const kind of ["qr", "code128", "datamatrix", "ean13"] as const) {
			expect(createElement(emptyDoc(), kind)).toMatchObject({ kind: "code", symbology: kind });
		}
	});
});

describe("editing", () => {
	it("moves unlocked elements only", () => {
		let doc = withElements(2);

		doc = updateElement(doc, "e1", { locked: true });
		const moved = moveBy(doc, ["e0", "e1"], 5, -3);

		expect(moved.elements[0].x).toBe(doc.elements[0].x + 5);
		expect(moved.elements[0].y).toBe(doc.elements[0].y - 3);
		expect(moved.elements[1]).toEqual(doc.elements[1]);
	});

	it("duplicates above the originals with new ids, unlocked and offset", () => {
		const doc = updateElement(withElements(2), "e0", { locked: true });
		const result = duplicate(doc, ["e0"]);

		expect(result.doc.elements).toHaveLength(3);
		const copy = result.doc.elements[2];

		expect(result.ids).toEqual([copy.id]);
		expect(copy.id).not.toBe("e0");
		expect(copy.locked).toBe(false);
		expect(copy.x).toBeGreaterThan(doc.elements[0].x);
	});

	it("removes by id", () => {
		expect(ids(removeElements(withElements(3), ["e1"]))).toEqual(["e0", "e2"]);
	});
});

describe("reorder", () => {
	const doc = withElements(4);

	it("brings forward one step", () => {
		expect(ids(reorder(doc, ["e1"], "forward"))).toEqual(["e0", "e2", "e1", "e3"]);
	});

	it("sends backward one step", () => {
		expect(ids(reorder(doc, ["e2"], "backward"))).toEqual(["e0", "e2", "e1", "e3"]);
	});

	it("keeps a selected block together at the top", () => {
		expect(ids(reorder(doc, ["e2", "e3"], "forward"))).toEqual(["e0", "e1", "e2", "e3"]);
	});

	it("jumps to front and back", () => {
		expect(ids(reorder(doc, ["e0"], "front"))).toEqual(["e1", "e2", "e3", "e0"]);
		expect(ids(reorder(doc, ["e3"], "back"))).toEqual(["e3", "e0", "e1", "e2"]);
	});

	it("moves to an absolute index", () => {
		expect(ids(moveToIndex(doc, "e3", 1))).toEqual(["e0", "e3", "e1", "e2"]);
	});
});

describe("align", () => {
	it("aligns a single element to the band", () => {
		const doc = withElements(1);
		const frame = { w: 400, h: TAPES[12].pins };
		const right = align(doc, ["e0"], "right", frame, {});

		expect(right.elements[0].x + right.elements[0].w).toBe(400);
		const middle = align(doc, ["e0"], "middle", frame, {});

		expect(middle.elements[0].y).toBe(Math.round((frame.h - doc.elements[0].h) / 2));
	});

	it("aligns several to their shared box using resolved boxes", () => {
		const doc = withElements(2);
		const boxes = { e0: { x: 10, y: 0, w: 20, h: 10 }, e1: { x: 100, y: 0, w: 50, h: 10 } };
		const left = align(doc, ["e0", "e1"], "left", { w: 500, h: 70 }, boxes);

		expect(left.elements.map((element) => element.x)).toEqual([10, 10]);
		const right = align(doc, ["e0", "e1"], "right", { w: 500, h: 70 }, boxes);

		expect(right.elements.map((element) => element.x)).toEqual([130, 100]);
	});
});

describe("retape", () => {
	it("scales the composition by the band ratio", () => {
		const doc = withElements(1);
		const smaller = retape(doc, 9);
		const ratio = TAPES[9].pins / TAPES[12].pins;

		expect(smaller.tapeMm).toBe(9);
		expect(smaller.elements[0].h).toBe(Math.round(doc.elements[0].h * ratio));
		expect((smaller.elements[0] as ShapeElement).stroke).toBeGreaterThanOrEqual(1);
	});

	it("is the identity for the same tape", () => {
		const doc = withElements(1);

		expect(retape(doc, 12)).toBe(doc);
	});
});
