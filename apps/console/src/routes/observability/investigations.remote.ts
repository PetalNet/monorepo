import { getRequestEvent } from "$app/server";
const env = import.meta.env;
import type {
	InvestigationDetail,
	InvestigationNode,
	InvestigationPanel,
} from "$lib/data/investigations";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { error } from "@sveltejs/kit";
import { Effect, Schema } from "effect";
import { Command, Query } from "svelte-effect-runtime";

const nodeId = Schema.Struct({
	id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
}).annotate(rejectUnknownKeys);
const branchInput = Schema.Struct({
	title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	queryRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	panelTitle: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	panelType: Schema.Literals(["bar", "line", "stat", "table", "scatter"]),
	parentId: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
	parentQuestion: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
	scope: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
	selectedField: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	selectedValue: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
}).annotate(rejectUnknownKeys);

function isMock(): boolean {
	return env.PUBLIC_CONSOLE_DATA_MODE !== "live";
}

function apiBase(): string {
	return env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
}

function headers(contentType = false): Headers {
	const incoming = getRequestEvent().request.headers;
	const result = new Headers({ accept: "application/json" });
	for (const name of ["authorization", "cookie", "x-dev-principal"]) {
		const value = incoming.get(name);
		if (value) result.set(name, value);
	}
	if (contentType) result.set("content-type", "application/json");
	return result;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await getRequestEvent().fetch(`${apiBase()}${path}`, {
		...init,
		headers: init?.headers ?? headers(init?.body !== undefined),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: { message?: string };
		} | null;
		error(
			response.status,
			body?.error?.message ?? `Console API returned ${String(response.status)}`,
		);
	}
	return (await response.json()) as T;
}

type DashboardRow = {
	id: string;
	title: string;
	is_home: boolean;
	created_by?: string | null;
	updated_at: string;
	panel_count: number;
	scope: string;
	is_investigation?: boolean;
	parent_id?: string | null;
	parent_question?: string | null;
};

type DashboardDetail = DashboardRow & {
	payload?: { panels?: Array<Record<string, unknown>> };
	materialized_panels?: Array<{
		panel?: Record<string, unknown>;
		result?: {
			columns?: Array<{ name?: string }>;
			rows?: unknown[][];
			row_count?: number;
			query_ref?: string;
			freshness?: { source?: string; observed_at?: string };
		} | null;
	}>;
};

function normalizeNode(row: DashboardRow): InvestigationNode {
	return {
		id: row.id,
		title: row.title,
		parentId: row.parent_id ?? null,
		parentQuestion: row.parent_question ?? null,
		panelCount: row.panel_count,
		createdBy: row.created_by ?? null,
		updatedAt: row.updated_at,
		scope: row.scope,
		isHome: row.is_home,
	};
}

function normalizePanel(
	raw: NonNullable<DashboardDetail["materialized_panels"]>[number],
): InvestigationPanel {
	const panel = raw.panel ?? {};
	const result = raw.result;
	const refusal = panel["refusal"];
	return {
		title: typeof panel["title"] === "string" ? panel["title"] : "Untitled panel",
		description: typeof panel["description"] === "string" ? panel["description"] : null,
		type: typeof panel["type"] === "string" ? panel["type"] : "table",
		queryRef:
			result?.query_ref ?? (typeof panel["query_ref"] === "string" ? panel["query_ref"] : null),
		columns: result?.columns?.map(({ name }) => name ?? "value") ?? [],
		rows: result?.rows ?? [],
		rowCount: result?.row_count ?? 0,
		source: result?.freshness?.source ?? null,
		observedAt: result?.freshness?.observed_at ?? null,
		refusal:
			refusal &&
			typeof refusal === "object" &&
			"reason" in refusal &&
			typeof refusal.reason === "string"
				? refusal.reason
				: null,
	};
}

const fixtureTime = "2026-07-13T15:08:00Z";
const mockNodes: InvestigationNode[] = [
	{
		id: "dash_mock_root",
		title: "Why did fleet event volume spike?",
		parentId: null,
		parentQuestion: null,
		panelCount: 1,
		createdBy: "janet",
		updatedAt: fixtureTime,
		scope: "lab",
		isHome: false,
	},
	{
		id: "dash_mock_agent",
		title: "Which scopes changed most?",
		parentId: "dash_mock_root",
		parentQuestion: "Why did fleet event volume spike?",
		panelCount: 1,
		createdBy: "janet",
		updatedAt: "2026-07-13T15:10:00Z",
		scope: "lab",
		isHome: false,
	},
	{
		id: "dash_mock_host",
		title: "Was host traffic behind the change?",
		parentId: "dash_mock_agent",
		parentQuestion: "Which scopes changed most?",
		panelCount: 1,
		createdBy: "terra",
		updatedAt: "2026-07-13T15:12:00Z",
		scope: "lab",
		isHome: true,
	},
	{
		id: "dash_mock_deploy",
		title: "Compare with the deploy window",
		parentId: "dash_mock_root",
		parentQuestion: "Why did fleet event volume spike?",
		panelCount: 1,
		createdBy: "parker",
		updatedAt: "2026-07-13T15:11:00Z",
		scope: "lab",
		isHome: false,
	},
];

function mockDetail(node: InvestigationNode): InvestigationDetail {
	return {
		node,
		panels: [
			{
				title: "Event volume by scope",
				description: "24h visible event count · viewer-scoped replay",
				type: "bar",
				queryRef: "qry_mock_investigation",
				columns: ["scope", "events"],
				rows: [
					["lab.fleet.*", 41208],
					["host.*", 22114],
					["home.ha.*", 14551],
				],
				rowCount: 3,
				source: "mock fixture",
				observedAt: fixtureTime,
				refusal: null,
			},
		],
	};
}

export const getInvestigationGraph = Query(
	Effect.promise(async (): Promise<InvestigationNode[]> => {
		if (isMock()) return mockNodes;
		const nodes: InvestigationNode[] = [];
		let cursor: string | null = null;
		do {
			// Cursor pages are causally ordered; the next request cannot be constructed in parallel.
			// oxlint-disable-next-line no-await-in-loop
			const envelope: { items: DashboardRow[]; next_cursor?: string | null } = await apiJson(
				`/dashboards?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			nodes.push(
				...envelope.items
					.filter(({ is_investigation }) => is_investigation === true)
					.map(normalizeNode),
			);
			cursor = envelope.next_cursor ?? null;
		} while (cursor);
		return nodes;
	}),
);

export const loadInvestigationNode = Query(nodeId, ({ id }) =>
	Effect.promise(async (): Promise<InvestigationDetail> => {
		if (isMock()) return mockDetail(mockNodes.find((node) => node.id === id) ?? mockNodes[0]);
		const detail = await apiJson<DashboardDetail>(`/dashboards/${encodeURIComponent(id)}`);
		return {
			node: normalizeNode(detail),
			panels: (detail.materialized_panels ?? []).map(normalizePanel),
		};
	}),
);

export const createInvestigationNode = Command(branchInput, (input) =>
	Effect.promise(async (): Promise<InvestigationNode> => {
		if (isMock())
			return {
				id: `dash_mock_${crypto.randomUUID()}`,
				title: input.title,
				parentId: input.parentId,
				parentQuestion: input.parentQuestion,
				panelCount: 1,
				createdBy: "you",
				updatedAt: new Date().toISOString(),
				scope: "lab",
				isHome: false,
			};
		const saved = await apiJson<DashboardRow>("/investigations/branches", {
			method: "POST",
			headers: headers(true),
			body: JSON.stringify({
				schema_version: 1,
				id: crypto.randomUUID(),
				title: input.title,
				...(input.scope ? { scope: input.scope } : {}),
				parent_dashboard_id: input.parentId,
				parent_question: input.parentQuestion,
				panel: {
					type: input.panelType,
					title: input.panelTitle,
					query_ref: input.queryRef,
				},
				selected_mark: {
					element_kind: "table-row",
					field: input.selectedField,
					value: input.selectedValue,
				},
			}),
		});
		return normalizeNode({
			...saved,
			is_investigation: true,
			parent_id: input.parentId,
			parent_question: input.parentQuestion,
		});
	}),
);

export const pinInvestigationNode = Command(nodeId, ({ id }) =>
	Effect.promise(async () => {
		if (isMock()) return { id, isHome: true };
		await apiJson(`/dashboards/${encodeURIComponent(id)}/home`, {
			method: "POST",
			headers: headers(true),
			body: JSON.stringify({ id: crypto.randomUUID() }),
		});
		void Effect.runPromise(getInvestigationGraph().refresh());
		return { id, isHome: true };
	}),
);
