export interface InvestigationNode {
	id: string;
	title: string;
	parentId: string | null;
	parentQuestion: string | null;
	panelCount: number;
	createdBy: string | null;
	updatedAt: string;
	scope: string;
	isHome: boolean;
}

export interface InvestigationPanel {
	title: string;
	description: string | null;
	type: string;
	queryRef: string | null;
	columns: string[];
	rows: unknown[][];
	rowCount: number;
	source: string | null;
	observedAt: string | null;
	refusal: string | null;
}

export interface InvestigationDetail {
	node: InvestigationNode;
	panels: InvestigationPanel[];
}

export interface InvestigationTreeRow extends InvestigationNode {
	depth: number;
	hasChildren: boolean;
}

/** Turns the server's parentId edges into a stable pre-order rail and rejects cyclic edges. */
export function visibleInvestigationRows(
	nodes: readonly InvestigationNode[],
	collapsed: ReadonlySet<string>,
): InvestigationTreeRow[] {
	const ids = new Set(nodes.map(({ id }) => id));
	const children = new Map<string | null, InvestigationNode[]>();
	for (const node of nodes) {
		const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
		const siblings = children.get(parent) ?? [];
		siblings.push(node);
		children.set(parent, siblings);
	}
	for (const siblings of children.values())
		siblings.sort(
			(a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id),
		);

	const rows: InvestigationTreeRow[] = [];
	const visited = new Set<string>();
	const rootConnected = new Set<string>();
	function markConnected(parentId: string | null) {
		for (const node of children.get(parentId) ?? []) {
			if (rootConnected.has(node.id)) continue;
			rootConnected.add(node.id);
			markConnected(node.id);
		}
	}
	markConnected(null);
	function walk(parentId: string | null, depth: number) {
		for (const node of children.get(parentId) ?? []) {
			if (visited.has(node.id)) continue;
			visited.add(node.id);
			const hasChildren = (children.get(node.id)?.length ?? 0) > 0;
			rows.push({ ...node, depth, hasChildren });
			if (!collapsed.has(node.id)) walk(node.id, depth + 1);
		}
	}
	walk(null, 0);
	// A fully cyclic component has no root. Keep it visible as a safe root instead of dropping evidence.
	for (const node of nodes)
		if (!rootConnected.has(node.id)) rows.push({ ...node, depth: 0, hasChildren: false });
	return rows;
}

export function ancestorTrail(
	nodes: readonly InvestigationNode[],
	activeId: string,
): InvestigationNode[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const trail: InvestigationNode[] = [];
	const visited = new Set<string>();
	let current = byId.get(activeId);
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		trail.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return trail;
}
