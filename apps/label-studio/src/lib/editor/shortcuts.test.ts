import { describe, expect, it } from "vitest";

import { resolveShortcut, type KeyLike } from "./shortcuts";

const key = (value: string, extra: Partial<KeyLike> = {}): KeyLike => ({
	key: value,
	shiftKey: false,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	...extra,
});

describe("shortcuts", () => {
	it("nudges by one, or ten with shift", () => {
		expect(resolveShortcut(key("ArrowLeft"))).toEqual({ kind: "nudge", dx: -1, dy: 0 });

		expect(resolveShortcut(key("ArrowDown", { shiftKey: true }))).toEqual({
			kind: "nudge",
			dx: 0,
			dy: 10,
		});
	});

	it("treats cmd and ctrl alike", () => {
		expect(resolveShortcut(key("z", { metaKey: true }))).toEqual({ kind: "undo" });
		expect(resolveShortcut(key("Z", { ctrlKey: true, shiftKey: true }))).toEqual({ kind: "redo" });
		expect(resolveShortcut(key("d", { ctrlKey: true }))).toEqual({ kind: "duplicate" });
		expect(resolveShortcut(key("0", { metaKey: true }))).toEqual({ kind: "zoom", to: "fit" });
	});

	it("maps brackets to layer order and backspace to delete", () => {
		expect(resolveShortcut(key("]"))).toEqual({ kind: "layer", move: "forward" });
		expect(resolveShortcut(key("Backspace"))).toEqual({ kind: "delete" });
	});

	it("ignores unbound keys", () => {
		expect(resolveShortcut(key("q"))).toBeNull();
		expect(resolveShortcut(key("q", { metaKey: true }))).toBeNull();
	});
});
