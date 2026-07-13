import type { LibraryItemView, LibraryLinkFixture } from "./library.ts";

export const WORK_LANES = ["todo", "doing", "review", "done"] as const;
export const KNOWLEDGE_LANES = ["draft", "verified-shared", "superseded", "invalidated"] as const;
export type WorkLane = (typeof WORK_LANES)[number];
export type KnowledgeLane = (typeof KNOWLEDGE_LANES)[number];

export interface LibraryGraphNode extends LibraryItemView {
	x: number;
	y: number;
	level: number;
}

export interface LibraryGraphEdge {
	from: string;
	to: string;
	rel: LibraryLinkFixture["rel"];
	reason?: string;
}

export interface LibraryGraphModel {
	nodes: LibraryGraphNode[];
	edges: LibraryGraphEdge[];
	width: number;
	height: number;
}

function directedEdges(
	items: readonly LibraryItemView[],
	links: Readonly<Record<string, readonly LibraryLinkFixture[]>>,
): LibraryGraphEdge[] {
	const visible = new Set(items.map(({ id }) => id));
	const seen = new Set<string>();
	const edges: LibraryGraphEdge[] = [];
	for (const [sourceId, sourceLinks] of Object.entries(links)) {
		for (const link of sourceLinks) {
			const from = link.direction === "out" ? sourceId : link.targetId;
			const to = link.direction === "out" ? link.targetId : sourceId;
			const key = `${from}\u0000${to}\u0000${link.rel}`;
			if (!visible.has(from) || !visible.has(to) || seen.has(key)) continue;
			seen.add(key);
			edges.push({ from, to, rel: link.rel, ...(link.reason ? { reason: link.reason } : {}) });
		}
	}
	return edges;
}

/**
 * Deterministic, bounded DAG layout. Cycles remain visible without making layout iteration
 * unbounded.
 */
export function buildLibraryGraph(
	items: readonly LibraryItemView[],
	links: Readonly<Record<string, readonly LibraryLinkFixture[]>>,
): LibraryGraphModel {
	const edges = directedEdges(items, links);
	const levels = new Map(items.map(({ id }) => [id, 0]));
	for (let pass = 0; pass < Math.max(0, items.length - 1); pass += 1) {
		let changed = false;
		for (const edge of edges) {
			const proposed = Math.min(items.length - 1, (levels.get(edge.from) ?? 0) + 1);
			if (proposed > (levels.get(edge.to) ?? 0)) {
				levels.set(edge.to, proposed);
				changed = true;
			}
		}
		if (!changed) break;
	}
	const columns = new Map<number, LibraryItemView[]>();
	for (const item of items) {
		const level = levels.get(item.id) ?? 0;
		const column = columns.get(level) ?? [];
		column.push(item);
		columns.set(level, column);
	}
	const xGap = 216;
	const yGap = 112;
	const insetX = 72;
	const insetY = 64;
	const nodes = [...columns.entries()].flatMap(([level, column]) =>
		column.map((entry, row) => ({
			...entry,
			level,
			x: insetX + level * xGap,
			y: insetY + row * yGap,
		})),
	);
	const maxLevel = Math.max(0, ...nodes.map(({ level }) => level));
	const maxRows = Math.max(1, ...columns.values().map((column) => column.length));
	return {
		nodes,
		edges,
		width: Math.max(720, insetX * 2 + maxLevel * xGap + 160),
		height: Math.max(480, insetY * 2 + (maxRows - 1) * yGap + 72),
	};
}

export type GraphWalkDirection = "left" | "right" | "up" | "down";

export function nextGraphNode(
	currentId: string,
	direction: GraphWalkDirection,
	links: Readonly<Record<string, readonly LibraryLinkFixture[]>>,
): string | null {
	const candidates: string[] = [];
	for (const [sourceId, sourceLinks] of Object.entries(links)) {
		for (const link of sourceLinks) {
			const from = link.direction === "out" ? sourceId : link.targetId;
			const to = link.direction === "out" ? link.targetId : sourceId;
			const candidate =
				direction === "left" && to === currentId
					? from
					: direction !== "left" && from === currentId
						? to
						: null;
			if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
		}
	}
	if (candidates.length === 0) return null;
	return candidates[direction === "down" ? candidates.length - 1 : 0] ?? null;
}

export interface LibraryKanbanGroups {
	work: Record<WorkLane, LibraryItemView[]>;
	knowledge: Record<KnowledgeLane, LibraryItemView[]>;
	conflicts: LibraryItemView[];
	unclassified: LibraryItemView[];
}

export function groupLibraryKanban(items: readonly LibraryItemView[]): LibraryKanbanGroups {
	const work: Record<WorkLane, LibraryItemView[]> = { todo: [], doing: [], review: [], done: [] };
	const knowledge: Record<KnowledgeLane, LibraryItemView[]> = {
		draft: [],
		"verified-shared": [],
		superseded: [],
		invalidated: [],
	};
	const conflicts: LibraryItemView[] = [];
	const unclassified: LibraryItemView[] = [];
	for (const item of items) {
		if (item.status.toLowerCase() === "conflict") {
			conflicts.push(item);
			continue;
		}
		if (item.kind === "task" && WORK_LANES.includes(item.status as WorkLane)) {
			work[item.status as WorkLane].push(item);
		} else if (KNOWLEDGE_LANES.includes(item.status as KnowledgeLane)) {
			knowledge[item.status as KnowledgeLane].push(item);
		} else {
			unclassified.push(item);
		}
	}
	return { work, knowledge, conflicts, unclassified };
}
