import { interpolate, isTapeWidth, type LabelDoc, type TemplateField, type Vars } from "$lib/doc";

/** What survives a reload: the document, the template it came from and its field values. */
export interface Session {
	doc: LabelDoc;
	template: { id: string; name: string; builtin: boolean; fields: TemplateField[] } | null;
	vars: Record<string, string>;
	/** The user chose a tape width by hand, so a newly detected cassette does not relayout. */
	tapePinned: boolean;
}

const KEY = "label-studio:session:v1";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Accepts anything that looks like a version-1 document; the renderer tolerates the rest. */
function parseDoc(value: unknown): LabelDoc | null {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!isTapeWidth(value.tapeMm) ||
		!Array.isArray(value.elements)
	) {
		return null;
	}

	return value as unknown as LabelDoc;
}

function parseVars(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

/** @internal Exported for its tests. */
export function parseSession(raw: string | null): Session | null {
	if (raw === null) {
		return null;
	}

	let value: unknown;

	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!isRecord(value)) {
		return null;
	}

	const doc = parseDoc(value.doc);

	if (!doc) {
		return null;
	}

	const template =
		isRecord(value.template) && typeof value.template.id === "string"
			? (value.template as unknown as Session["template"])
			: null;

	return { doc, template, vars: parseVars(value.vars), tapePinned: value.tapePinned === true };
}

export function loadSession(storage: Pick<Storage, "getItem">): Session | null {
	return parseSession(storage.getItem(KEY));
}

export function saveSession(storage: Pick<Storage, "setItem">, session: Session): void {
	try {
		storage.setItem(KEY, JSON.stringify(session));
	} catch {
		// Quota exceeded (a large image): the in-memory session still works.
	}
}

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * The variables every label can use, `{{today}}` and `{{now}}`, the same names the server provides
 * when it prints. The preview uses the browser's clock.
 */
function builtinVars(now: Date): Record<string, string> {
	const today = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

	return { today, now: `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}` };
}

/** Built-ins, under field defaults (which may use built-ins), under the user's values. */
export function resolveVars(
	fields: readonly TemplateField[],
	vars: Vars,
	now = new Date(),
): Record<string, string> {
	const builtins = builtinVars(now);
	const defaults = Object.fromEntries(
		fields.map((field) => [field.key, interpolate(field.default, builtins)]),
	);

	return { ...builtins, ...defaults, ...vars };
}

/**
 * Starting values for a freshly opened template: a field with no default takes its example text, so
 * the label shows (and would print) something real until the user types over it.
 */
export function sampleVars(fields: readonly TemplateField[]): Record<string, string> {
	return Object.fromEntries(
		fields
			.filter((field) => field.default === "")
			.map((field) => [field.key, field.placeholder ?? field.label]),
	);
}
