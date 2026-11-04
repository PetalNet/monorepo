/** The export name for a kebab-case icon name, the way a renderer looks it up. */
export function pascal(name: string): string {
	return name
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/** Lucide's export names are PascalCase; documents store the kebab-case icon name. */
export function kebab(exportName: string): string {
	return exportName
		.replaceAll(/([a-z])([A-Z0-9])/g, "$1-$2")
		.replaceAll(/([A-Z])([A-Z][a-z])/g, "$1-$2")
		.replaceAll(/(\d)([A-Z])/g, "$1-$2")
		.toLowerCase();
}

/** Icons people reach for on labels, shown before any search. */
export const SUGGESTED = [
	"tag",
	"triangle-alert",
	"zap",
	"plug",
	"cable",
	"usb",
	"wifi",
	"server",
	"hard-drive",
	"router",
	"power",
	"battery",
	"thermometer",
	"flame",
	"snowflake",
	"droplet",
	"leaf",
	"sprout",
	"flower-2",
	"coffee",
	"utensils",
	"wheat",
	"apple",
	"cookie",
	"package",
	"box",
	"archive",
	"folder",
	"file-text",
	"book",
	"pencil",
	"scissors",
	"key",
	"lock",
	"house",
	"lamp",
	"bath",
	"baby",
	"dog",
	"cat",
	"phone",
	"laptop",
	"monitor",
	"printer",
	"camera",
	"music",
	"wrench",
	"hammer",
	"recycle",
	"trash-2",
	"heart",
	"star",
	"calendar",
	"clock",
	"info",
	"ban",
	"biohazard",
	"radiation",
	"skull",
	"shield-alert",
	"sun",
	"moon",
] as const;

export interface IconEntry {
	/** The name stored in the document: the alias that matched a search, else the first. */
	name: string;
	/** Every name Lucide exports for this drawing (renames keep their old names as aliases). */
	names: string[];
	node: [string, Record<string, string>][];
}

let catalog: Promise<IconEntry[]> | null = null;

/** The full Lucide set, loaded on first open so the editor bundle stays small. */
export function loadIcons(): Promise<IconEntry[]> {
	catalog ??= import("lucide").then(({ icons }) => {
		const byNode = new Map<unknown, string[]>();

		for (const [name, node] of Object.entries(icons)) {
			const names = byNode.get(node) ?? [];

			names.push(kebab(name));
			byNode.set(node, names);
		}

		return [...byNode]
			.map(([node, names]) => ({ name: names[0], names, node: node as IconEntry["node"] }))
			.toSorted((a, b) => a.name.localeCompare(b.name));
	});

	return catalog;
}

/** Prefix matches first, then substring matches, over every alias. */
export function searchIcons(
	entries: readonly IconEntry[],
	query: string,
	limit = 120,
): IconEntry[] {
	const needle = query.trim().toLowerCase().replaceAll(/\s+/g, "-");

	if (needle === "") {
		return SUGGESTED.flatMap((wanted) => {
			const entry = entries.find((candidate) => candidate.names.includes(wanted));

			return entry ? [{ ...entry, name: wanted }] : [];
		});
	}

	const starts: IconEntry[] = [];
	const contains: IconEntry[] = [];

	for (const entry of entries) {
		const prefix = entry.names.find((name) => name.startsWith(needle));
		const inner = prefix ?? entry.names.find((name) => name.includes(needle));

		if (prefix !== undefined) {
			starts.push({ ...entry, name: prefix });
		} else if (inner !== undefined) {
			contains.push({ ...entry, name: inner });
		}
	}

	return [...starts, ...contains].slice(0, limit);
}
