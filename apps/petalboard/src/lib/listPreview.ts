/** How many entries a long guest or song list shows before its "Show all" control. */
export const LIST_PREVIEW_SIZE = 8;

export function previewList<T>(items: readonly T[], expanded: boolean): readonly T[] {
	return expanded ? items : items.slice(0, LIST_PREVIEW_SIZE);
}
