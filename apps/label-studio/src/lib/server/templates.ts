import type { Template } from "$lib/doc";
import { BUILTIN_TEMPLATES } from "$lib/templates/builtin";

import type { Store } from "./store.ts";

export function allTemplates(store: Store): Template[] {
	return [...BUILTIN_TEMPLATES, ...store.listTemplates()];
}

/** By exact id first, then by case-insensitive name; built-ins win a name clash. */
export function findTemplate(store: Store, idOrName: string): Template | null {
	const lower = idOrName.toLowerCase();

	return (
		BUILTIN_TEMPLATES.find((template) => template.id === idOrName) ??
		BUILTIN_TEMPLATES.find((template) => template.name.toLowerCase() === lower) ??
		store.findTemplate(idOrName)
	);
}

export const isBuiltinId = (id: string): boolean => id.startsWith("builtin:");
