export type PaletteKind =
	| "action"
	| "surface"
	| "agent"
	| "task"
	| "library"
	| "host"
	| "statistic";

export interface PaletteItem {
	id: string;
	kind: PaletteKind;
	label: string;
	description: string;
	href?: string;
	meta?: string;
	score?: number;
}

export type PaletteSourceState = "live" | "unavailable";

export interface PaletteSearchResponse {
	schema_version: 1;
	freshness: { source: "palette"; observed_at: string; window_s: 0 };
	query: string;
	items: PaletteItem[];
	sources: Record<"agents" | "tasks" | "library" | "hosts" | "statistics", PaletteSourceState>;
}

const MOCK_ITEMS: PaletteItem[] = [
	{
		id: "agent:janet",
		kind: "agent",
		label: "Janet",
		description: "@janet · orchestrator · .14",
		href: "/agents?agent=janet",
		meta: "working",
	},
	{
		id: "agent:carson-2",
		kind: "agent",
		label: "Carson 2",
		description: "@carson-2 · builder · .14",
		href: "/agents?agent=carson-2",
		meta: "resident",
	},
	{
		id: "task:742",
		kind: "task",
		label: "Restore lake retention job",
		description: "/task/742 · todo · console",
		href: "/work?task=742",
		meta: "carson-2 suggested",
	},
	{
		id: "task:731",
		kind: "task",
		label: "Doorman dashboard panel",
		description: "/task/731 · review · network",
		href: "/work?task=731",
		meta: "scout",
	},
	{
		id: "library:kb-1",
		kind: "library",
		label: "Backoff and retry discipline for fleet writers",
		description: "how-to · fleet",
		href: "/library?item=kb-1",
		meta: "verified-shared",
	},
	{
		id: "host:.14",
		kind: "host",
		label: ".14",
		description: "Host · up to date",
		href: "/hosts?host=.14",
		meta: "checked now",
	},
	{
		id: "statistic:host.cpu.pct",
		kind: "statistic",
		label: "host.cpu.pct",
		description: "CPU gauge by host",
		href: "/observability?stat=host.cpu.pct",
		meta: "statistic",
	},
];

function mockScore(query: string, item: PaletteItem): number | null {
	const needle = query.toLocaleLowerCase().replaceAll(/\s+/g, "");
	const haystack = `${item.label} ${item.description} ${item.meta ?? ""}`.toLocaleLowerCase();
	if (haystack.includes(query.toLocaleLowerCase())) return 100;
	let cursor = 0;
	for (const character of needle) {
		cursor = haystack.indexOf(character, cursor);
		if (cursor < 0) return null;
		cursor += 1;
	}
	return 40;
}

export function searchMockPalette(query: string): PaletteSearchResponse {
	const items = MOCK_ITEMS.flatMap((item) => {
		const score = mockScore(query, item);
		return score === null ? [] : [{ ...item, score }];
	}).toSorted((left, right) => (right.score ?? 0) - (left.score ?? 0));
	return {
		schema_version: 1,
		freshness: { source: "palette", observed_at: new Date().toISOString(), window_s: 0 },
		query,
		items,
		sources: { agents: "live", tasks: "live", library: "live", hosts: "live", statistics: "live" },
	};
}
