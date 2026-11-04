/**
 * The one editor session: the document under undo history, the selection, the view, and the
 * template the document came from. Routes share it, so loading a template on the templates page and
 * coming back to the editor keeps everything.
 */
import {
	mmToDots,
	type Box,
	type LabelDoc,
	type LabelElement,
	type Template,
	type TapeWidthMm,
} from "$lib/doc";

import { commit, redo, startHistory, undo, type History } from "./history";
import {
	addElement,
	align,
	createElement,
	duplicate,
	emptyDoc,
	frameSize,
	moveBy,
	removeElements,
	reorder,
	retape,
	type AddKind,
	type AlignEdge,
	type LayerMove,
} from "./model";
import { loadSession, resolveVars, sampleVars, saveSession, type Session } from "./persist";

export type View = "design" | "print";

/** The editor panel tabs; "edit" exists only on narrow screens, "templates" only on wide ones. */
export type PanelTab = "add" | "edit" | "layers" | "templates";

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 16;

class Editor {
	history = $state.raw<History<LabelDoc>>(startHistory(emptyDoc()));
	selection = $state.raw<string[]>([]);
	view = $state<View>("design");
	/** CSS pixels per printer dot. `null` follows the fitted zoom. */
	zoom = $state<number | null>(null);
	fitZoom = $state(3);
	template = $state.raw<Session["template"]>(null);
	vars = $state<Record<string, string>>({});
	tapePinned = $state(false);
	/** The latest resolved geometry from the renderer, for overlays, alignment and the length readout. */
	boxes = $state.raw<Partial<Record<string, Box>>>({});
	lengthDots = $state(0);
	warnings = $state.raw<string[]>([]);
	/** Ask the inspector to focus the text field of this element (double-tap on canvas). */
	focusText = $state<string | null>(null);
	#restored = false;

	get doc(): LabelDoc {
		return this.history.present;
	}

	get canUndo(): boolean {
		return this.history.past.length > 0;
	}

	get canRedo(): boolean {
		return this.history.future.length > 0;
	}

	get effectiveZoom(): number {
		return this.zoom ?? this.fitZoom;
	}

	get selected(): LabelElement[] {
		const ids = new Set(this.selection);

		return this.doc.elements.filter((element) => ids.has(element.id));
	}

	get resolvedVars(): Record<string, string> {
		return resolveVars(this.template?.fields ?? [], this.vars);
	}

	get frame(): { w: number; h: number } {
		return frameSize(this.doc, Math.max(this.lengthDots, 1));
	}

	restore(): void {
		if (this.#restored) {
			return;
		}

		this.#restored = true;
		const session = loadSession(localStorage);

		if (session) {
			this.history = startHistory(session.doc);
			this.template = session.template;
			this.vars = session.vars;
			this.tapePinned = session.tapePinned;
		}

		$effect.root(() => {
			$effect(() => {
				saveSession(localStorage, {
					doc: this.doc,
					template: this.template,
					vars: $state.snapshot(this.vars),
					tapePinned: this.tapePinned,
				});
			});
		});
	}

	/** Apply an edit. Edits sharing `key` within a second merge into one undo step. */
	apply(next: LabelDoc, key: string | null = null): void {
		this.history = commit(this.history, next, key);
		const live = new Set(next.elements.map((element) => element.id));

		if (this.selection.some((id) => !live.has(id))) {
			this.selection = this.selection.filter((id) => live.has(id));
		}
	}

	undo(): void {
		this.history = undo(this.history);
		this.#pruneSelection();
	}

	redo(): void {
		this.history = redo(this.history);
		this.#pruneSelection();
	}

	#pruneSelection(): void {
		const live = new Set(this.doc.elements.map((element) => element.id));

		this.selection = this.selection.filter((id) => live.has(id));
	}

	select(ids: string[]): void {
		this.selection = ids;
	}

	toggleSelect(id: string): void {
		this.selection = this.selection.includes(id)
			? this.selection.filter((selected) => selected !== id)
			: [...this.selection, id];
	}

	add(kind: AddKind): void {
		const element = createElement(this.doc, kind, this.boxes);

		this.apply(addElement(this.doc, element));
		this.selection = [element.id];
	}

	insert(element: LabelElement): void {
		this.apply(addElement(this.doc, element));
		this.selection = [element.id];
	}

	nudge(dx: number, dy: number): void {
		if (this.selection.length > 0) {
			this.apply(moveBy(this.doc, this.selection, dx, dy), "nudge");
		}
	}

	duplicateSelection(): void {
		if (this.selection.length === 0) {
			return;
		}

		const result = duplicate(this.doc, this.selection);

		this.apply(result.doc);
		this.selection = result.ids;
	}

	deleteSelection(): void {
		const removable = this.selected
			.filter((element) => !element.locked)
			.map((element) => element.id);

		if (removable.length > 0) {
			this.apply(removeElements(this.doc, removable));
		}
	}

	layer(move: LayerMove): void {
		if (this.selection.length > 0) {
			this.apply(reorder(this.doc, this.selection, move));
		}
	}

	align(edge: AlignEdge): void {
		if (this.selection.length > 0) {
			this.apply(align(this.doc, this.selection, edge, this.frame, this.boxes));
		}
	}

	/** Lay the design out for another cassette. `pinned` marks a manual choice. */
	setTape(tapeMm: TapeWidthMm, pinned: boolean): void {
		this.tapePinned = pinned;

		if (tapeMm !== this.doc.tapeMm) {
			this.apply(retape(this.doc, tapeMm));
		}
	}

	setZoom(value: number | null): void {
		this.zoom = value === null ? null : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
	}

	zoomBy(factor: number): void {
		this.setZoom(this.effectiveZoom * factor);
	}

	/** Replace the document: a template, a history entry, or a new label. One undo step back. */
	load(doc: LabelDoc, template: Session["template"], vars: Record<string, string> = {}): void {
		this.history = commit(this.history, $state.snapshot(doc));
		this.template = template;
		this.vars = vars;
		this.selection = [];
		this.zoom = null;
		this.view = "design";
	}

	loadTemplate(template: Template): void {
		this.load(
			template.doc,
			{ id: template.id, name: template.name, builtin: template.builtin, fields: template.fields },
			sampleVars(template.fields),
		);
	}

	startBlank(tapeMm: TapeWidthMm): void {
		this.load(emptyDoc(tapeMm), null);
	}

	/** The start margin in dots, the guide new and dragged content snaps to. */
	get startMarginDots(): number {
		return mmToDots(this.doc.margin.startMm);
	}
}

export const editor = new Editor();
