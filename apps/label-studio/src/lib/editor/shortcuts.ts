/** Everything a key press can do in the editor. */
export type Command =
	| { kind: "nudge"; dx: number; dy: number }
	| { kind: "undo" }
	| { kind: "redo" }
	| { kind: "duplicate" }
	| { kind: "delete" }
	| { kind: "layer"; move: "forward" | "backward" }
	| { kind: "zoom"; to: "in" | "out" | "fit" }
	| { kind: "select-all" }
	| { kind: "escape" }
	| { kind: "help" }
	| { kind: "view" };

export interface KeyLike {
	key: string;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
}

const ARROWS: Record<string, [number, number]> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};

/** The shortcut sheet and the key handler read this one table. */
export const SHORTCUTS: readonly { keys: string; does: string }[] = [
	{ keys: "Arrows", does: "Nudge 1 dot" },
	{ keys: "Shift + Arrows", does: "Nudge 10 dots" },
	{ keys: "Mod + Z", does: "Undo" },
	{ keys: "Mod + Shift + Z", does: "Redo" },
	{ keys: "Mod + D", does: "Duplicate" },
	{ keys: "Mod + A", does: "Select all" },
	{ keys: "Backspace", does: "Delete" },
	{ keys: "[  ]", does: "Send backward, bring forward" },
	{ keys: "Mod + 0", does: "Zoom to fit" },
	{ keys: "Mod + =  Mod + −", does: "Zoom in, zoom out" },
	{ keys: "P", does: "Design or print view" },
	{ keys: "Esc", does: "Clear selection" },
	{ keys: "?", does: "This sheet" },
];

export function resolveShortcut(event: KeyLike): Command | null {
	const mod = event.metaKey || event.ctrlKey;
	const arrow = ARROWS[event.key] as [number, number] | undefined;

	if (arrow && !mod && !event.altKey) {
		const step = event.shiftKey ? 10 : 1;

		return { kind: "nudge", dx: arrow[0] * step, dy: arrow[1] * step };
	}

	if (mod) {
		switch (event.key.toLowerCase()) {
			case "z":
				return event.shiftKey ? { kind: "redo" } : { kind: "undo" };
			case "y":
				return { kind: "redo" };
			case "d":
				return { kind: "duplicate" };
			case "a":
				return { kind: "select-all" };
			case "0":
				return { kind: "zoom", to: "fit" };
			case "=":
			case "+":
				return { kind: "zoom", to: "in" };
			case "-":
				return { kind: "zoom", to: "out" };
			default:
				return null;
		}
	}

	switch (event.key) {
		case "Backspace":
		case "Delete":
			return { kind: "delete" };
		case "[":
			return { kind: "layer", move: "backward" };
		case "]":
			return { kind: "layer", move: "forward" };
		case "Escape":
			return { kind: "escape" };
		case "?":
			return { kind: "help" };
		case "p":
		case "P":
			return event.altKey ? null : { kind: "view" };
		default:
			return null;
	}
}
