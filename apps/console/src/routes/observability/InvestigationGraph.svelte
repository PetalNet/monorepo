<script lang="ts">
	import { formatUnknown } from "#format";
	import AgentPresence from "$lib/components/AgentPresence.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import type { InvestigationDetail, InvestigationNode, InvestigationPanel } from "$lib/data/investigations";
	import { ancestorTrail, visibleInvestigationRows } from "$lib/data/investigations";
	import { snackbar } from "$lib/stores/snackbar.svelte";
	import { createInvestigationNode, getInvestigationGraph, loadInvestigationNode, pinInvestigationNode } from "./investigations.remote";
	import type { InvestigationSeed } from "./investigation-types";

	interface Props {
		seed?: InvestigationSeed | null;
		initialId?: string | null;
		onseeded?: () => void;
	}

	let { seed = null, initialId = null, onseeded }: Props = $props();
	const graph = getInvestigationGraph();
	let nodes = $state<InvestigationNode[]>([]);
	let activeId = $state<string | null>(null);
	let detail = $state<InvestigationDetail | null>(null);
	let collapsed = $state<string[]>([]);
	let loading = $state(false);
	let action = $state<"branch" | "rerun" | "pin" | null>(null);
	let error = $state<string | null>(null);
	let consumedSeed = $state<InvestigationSeed | null>(null);
	let requestedId: string | null = null;
	let appliedGraph: readonly InvestigationNode[] | undefined;
	const rows = $derived(visibleInvestigationRows(nodes, new Set(collapsed)));
	const trail = $derived(activeId ? ancestorTrail(nodes, activeId) : []);
	const active = $derived(nodes.find((node) => node.id === activeId) ?? null);

	$effect(() => {
		const current = graph.current;
		if (!current || current === appliedGraph) return;
		appliedGraph = current;
		nodes = current;
		if (!activeId || !current.some(({ id }) => id === activeId))
			activeId = (initialId && current.some(({ id }) => id === initialId) ? initialId : current[0]?.id) ?? null;
	});

	$effect(() => {
		if (!seed || seed === consumedSeed) return;
		consumedSeed = seed;
		void createRoot(seed);
	});

	$effect(() => {
		const id = activeId;
		if (!id) {
			requestedId = null;
			detail = null;
		} else if (id !== requestedId) {
			requestedId = id;
			void openNode(id, true);
		}
	});

	async function openNode(id: string, force = false) {
		if (!force && detail?.node.id === id) return;
		loading = true;
		error = null;
		try {
			detail = await loadInvestigationNode({ id });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Investigation node could not be replayed";
		} finally {
			loading = false;
		}
	}

	async function createRoot(next: InvestigationSeed) {
		action = "branch";
		try {
			const node = await createInvestigationNode({ ...next, parentId: null, parentQuestion: null, scope: null });
			nodes = [...nodes, node];
			activeId = node.id;
			snackbar.push({ message: "Investigation started", op: "dashboard.save", tone: "good" });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Investigation could not be started";
		} finally {
			action = null;
			onseeded?.();
		}
	}

	async function drill(panel: InvestigationPanel, row: unknown[]) {
		if (!active || !panel.queryRef || action) return;
		const field = panel.columns[0] ?? "selection";
		const selected = row[0];
		if (typeof selected !== "string" && typeof selected !== "number" && typeof selected !== "boolean") return;
		const printable = selected;
		action = "branch";
		try {
			const node = await createInvestigationNode({
				title: `Why did ${String(printable)} stand out?`,
				queryRef: panel.queryRef,
				panelTitle: panel.title,
				panelType: ["bar", "line", "stat", "table", "scatter"].includes(panel.type) ? panel.type as "bar" : "table",
				parentId: active.id,
				parentQuestion: active.title,
				scope: active.scope,
				selectedField: field,
				selectedValue: selected,
			});
			nodes = [...nodes, node];
			collapsed = collapsed.filter((id) => id !== active.id);
			activeId = node.id;
			snackbar.push({ message: "Branch added", op: "dashboard.save", tone: "good" });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Branch could not be saved";
		} finally {
			action = null;
		}
	}

	async function rerun() {
		if (!activeId || action) return;
		action = "rerun";
		await openNode(activeId, true);
		action = null;
		snackbar.push({ message: "Node replayed with current evidence", op: "stats.query", tone: "good" });
	}

	async function pin() {
		if (!activeId || action) return;
		action = "pin";
		try {
			await pinInvestigationNode({ id: activeId });
			nodes = nodes.map((node) => ({ ...node, isHome: node.id === activeId }));
			snackbar.push({ message: "Node pinned as home", op: "dashboard.set_home", tone: "good" });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Node could not be pinned";
		} finally {
			action = null;
		}
	}

	function toggle(id: string) {
		collapsed = collapsed.includes(id) ? collapsed.filter((value) => value !== id) : [...collapsed, id];
	}

	function treeKey(event: KeyboardEvent, id: string) {
		const index = rows.findIndex((row) => row.id === id);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
			if (next) document.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(next.id)}"]`)?.focus();
		}
		if (event.key === "ArrowRight") { event.preventDefault(); collapsed = collapsed.filter((value) => value !== id); }
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			const row = rows[index];
			if (row.hasChildren && !collapsed.includes(id)) toggle(id);
			else if (row.parentId) document.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(row.parentId)}"]`)?.focus();
		}
		if (event.key === "Enter") { event.preventDefault(); activeId = id; }
	}

	function age(iso: string): string {
		const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
		return minutes < 60 ? `${String(minutes)}m` : minutes < 1_440 ? `${String(Math.round(minutes / 60))}h` : `${String(Math.round(minutes / 1_440))}d`;
	}

	function magnitude(panel: InvestigationPanel, row: unknown[]): number {
		const values = panel.rows.map((candidate) => candidate.findLast((value) => typeof value === "number")).filter((value): value is number => value !== undefined);
		const value = row.findLast((cell) => typeof cell === "number");
		return value === undefined ? 0 : Math.max(4, value / Math.max(...values, 1) * 100);
	}
</script>

<section class="investigation" aria-label="Branching investigation">
	<aside class="tree-rail">
		<header>
			<div><Icon name="git-branch" size={15} /><h2 title={nodes.length > 12 ? "Oh, the Time Knife. We've all seen it." : undefined}>Reasoning</h2></div>
			<span>{nodes.length} {nodes.length === 1 ? "node" : "nodes"}</span>
		</header>
		{#if !graph.current && nodes.length === 0}
			<div class="tree-skeleton" aria-label="Loading investigation tree"><i></i><i></i><i></i></div>
		{:else if rows.length === 0}
			<div class="empty"><Icon name="git-branch" size={20} /><b>No investigations yet.</b><span>Choose Investigate on an anomaly to preserve its reasoning path.</span></div>
		{:else}
			<div class="tree" role="tree" aria-label="Investigation nodes">
				{#each rows as row, index (row.id)}
					<div class="tree-row" style:--depth={row.depth}>
						{#if row.hasChildren}
							<button class="disclosure" aria-label={collapsed.includes(row.id) ? "Expand branch" : "Collapse branch"} onclick={() => { toggle(row.id); }}><Icon name={collapsed.includes(row.id) ? "chevron-right" : "chevron-down"} size={13} /></button>
						{:else}<span class="leaf"></span>{/if}
						<button
							class="node"
							class:active={row.id === activeId}
							data-node-id={row.id}
							role="treeitem"
							aria-level={row.depth + 1}
							aria-selected={row.id === activeId}
							tabindex={row.id === activeId || (!activeId && index === 0) ? 0 : -1}
							onclick={() => activeId = row.id}
							onkeydown={(event) => { treeKey(event, row.id); }}
						>
							<code>{index + 1}</code><span>{row.title}</span><small>{row.panelCount}p · {age(row.updatedAt)}</small>{#if row.isHome}<Icon name="pin" size={11} title="Pinned as home" />{/if}
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</aside>

	<main class="node-canvas">
		{#if active}
			<nav class="crumbs" aria-label="Investigation ancestry">
				{#each trail as ancestor, index (index)}
					{#if index > 0}<Icon name="chevron-right" size={12} />{/if}
					<button class:current={ancestor.id === active.id} onclick={() => activeId = ancestor.id}>{ancestor.title}</button>
				{/each}
			</nav>
			<div class="node-toolbar">
				<div><h2>{active.title}</h2><AgentPresence handle={active.createdBy} /></div>
				<div class="actions">
					<button disabled={action !== null || loading} onclick={rerun}><Icon name="refresh-cw" size={14} />{action === "rerun" ? "Re-running…" : "Re-run"}</button>
					<button class:pinned={active.isHome} disabled={action !== null || active.isHome} onclick={pin}><Icon name="pin" size={14} />{active.isHome ? "Pinned home" : action === "pin" ? "Pinning…" : "Pin as home"}</button>
				</div>
			</div>
			{#if error}<div class="error" role="status"><Icon name="triangle-alert" size={14} /><span>{error}. Last-known tree remains visible.</span></div>{/if}
			{#if loading}
				<div class="panel-skeleton" aria-label="Replaying investigation node"><i></i><i></i><i></i></div>
			{:else if detail}
				<div class="panels">
					{#each detail.panels as panel (panel.title)}
						<article class="panel">
							<header><div><h3>{panel.title}</h3>{#if panel.description}<p>{panel.description}</p>{/if}</div><span>{panel.type}</span></header>
							{#if panel.refusal}<div class="refusal"><Icon name="circle-alert" size={16} /><b>Can’t replay this panel.</b><span>{panel.refusal}</span><strong>No chart, no guess.</strong></div>
							{:else if panel.rows.length === 0}<div class="empty-panel">The replay returned no rows.</div>
							{:else if panel.type === "stat"}<div class="stat">{formatUnknown(panel.rows[0]?.at(-1) ?? "—")}</div>
							{:else}
								<div class="evidence-table" role="table" aria-label={panel.title}>
									<div class="table-head" role="row">{#each panel.columns as column, __eachKey48 (__eachKey48)}<span role="columnheader">{column}</span>{/each}<span></span></div>
									{#each panel.rows as row, __eachKey49 (__eachKey49)}
										<button role="row" disabled={!panel.queryRef || action !== null} onclick={() => drill(panel, row)} aria-label={`Drill into ${formatUnknown(row[0] ?? "row")}`}>
											{#each row as cell, __eachKey50 (__eachKey50)}<span role="cell">{typeof cell === "number" ? cell.toLocaleString() : String(cell)}</span>{/each}
											<i><em style:width={`${String(magnitude(panel, row))}%`}></em></i><span class="drill">Drill <Icon name="git-branch" size={12} /></span>
										</button>
									{/each}
								</div>
							{/if}
							<footer><Icon name="receipt-text" size={12} /><span>{panel.source ?? "source unavailable"} · {panel.rowCount} rows · {panel.observedAt ? age(panel.observedAt) : "freshness unknown"}</span><code>{panel.queryRef ?? "no query ref"}</code></footer>
						</article>
					{/each}
				</div>
			{/if}
		{:else}
			<div class="canvas-empty"><Icon name="mouse-pointer-2" size={20} /><b>Select a node</b><span>Its dashboard will replay here with current, viewer-scoped evidence.</span></div>
		{/if}
	</main>
</section>

<style>
	.investigation{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:560px;margin-top:var(--s-3);padding-bottom:104px;background:var(--s1);border-radius:var(--r-xs)}
	.tree-rail{border-inline-end:1px solid var(--rule);background:var(--bg);min-width:0}.tree-rail>header{height:48px;padding:0 var(--s-3);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--rule)}.tree-rail>header div{display:flex;align-items:center;gap:var(--s-2)}h2,h3{font:500 .84375rem var(--sans)}.tree-rail>header span{font:400 .6875rem var(--mono);color:var(--text-3)}
	.tree{padding:var(--s-2) 0}.tree-row{display:grid;grid-template-columns:24px minmax(0,1fr);padding-inline-start:calc(var(--depth) * 16px + 4px);position:relative}.tree-row:not(:last-child)::after{content:"";position:absolute;inset-inline-start:calc(var(--depth) * 16px + 15px);top:28px;height:8px;border-inline-start:1px solid var(--rule-strong)}.disclosure,.leaf{width:24px;height:32px;display:grid;place-items:center;border:0;background:none;color:var(--text-3)}.node{min-width:0;min-height:32px;padding:0 var(--s-2);border:0;border-radius:var(--r-xs);background:transparent;color:var(--text);display:grid;grid-template-columns:22px minmax(0,1fr) auto 14px;align-items:center;gap:var(--s-1);text-align:left;transition:background var(--t),color var(--t)}.node:hover{background:var(--s2)}.node.active{background:var(--petal-soft);color:var(--petal-text)}.node code,.node small{font:400 .6875rem var(--mono)}.node span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.75rem}.node small{color:var(--text-3)}
	.node-canvas{min-width:0;background:var(--bg)}.crumbs{min-height:32px;padding:0 var(--s-3);display:flex;align-items:center;gap:var(--s-1);border-bottom:1px solid var(--rule);overflow:hidden}.crumbs button{border:0;background:none;color:var(--text-3);font-size:.6875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:24ch}.crumbs button.current{color:var(--text);font-weight:500}.node-toolbar{min-height:64px;padding:var(--s-2) var(--s-3);display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);border-bottom:1px solid var(--rule)}.node-toolbar>div:first-child{min-width:0}.node-toolbar h2{font-size:.875rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;gap:var(--s-2)}.actions button{min-height:32px;padding:0 var(--s-3);border:0;border-radius:var(--r-sm);background:var(--petal-soft);color:var(--petal-text);font:500 .75rem var(--sans);display:flex;align-items:center;gap:var(--s-1);transition:background var(--t),transform var(--dur-fast) var(--ease-standard)}.actions button:first-child{background:var(--s2);color:var(--text-2)}.actions button:hover:not(:disabled){background:var(--s3)}.actions button:active:not(:disabled){transform:scale(.97)}.actions button.pinned{background:var(--jade-soft);color:var(--jade-text)}button:disabled{opacity:.48;cursor:not-allowed}
	.error{margin:var(--s-3);padding:var(--s-2) var(--s-3);display:flex;gap:var(--s-2);background:var(--warn-soft);color:var(--warn-text);font-size:.75rem}.panels{padding:var(--s-3);display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:var(--s-3)}.panel{grid-column:span 12;min-height:280px;padding:var(--s-3);background:var(--s1);border-radius:var(--r-md);display:flex;flex-direction:column;animation:replay var(--dur-mid) var(--ease-standard)}.panel header{display:flex;justify-content:space-between;gap:var(--s-2)}.panel header p{margin-top:var(--s-1);font-size:.6875rem;color:var(--text-3)}.panel header>span{font:500 .6875rem var(--mono);color:var(--jade-text)}.panel footer{margin-top:auto;padding-top:var(--s-2);border-top:1px solid var(--rule);display:flex;align-items:center;gap:var(--s-2);font:400 .6875rem var(--mono);color:var(--text-3)}.panel footer code{margin-inline-start:auto;max-width:24ch;overflow:hidden;text-overflow:ellipsis}.stat{margin:auto 0;font:500 1.75rem var(--mono);text-decoration:underline;text-decoration-color:var(--jade);text-underline-offset:5px}
	.evidence-table{margin:var(--s-3) 0}.table-head,.evidence-table>button{display:grid;grid-template-columns:minmax(120px,1fr) minmax(80px,.6fr) minmax(96px,1fr) 56px;align-items:center;gap:var(--s-2);min-height:36px;padding:0 var(--s-2)}.table-head{font:500 .6875rem var(--mono);color:var(--text-3);border-bottom:1px solid var(--rule)}.evidence-table>button{width:100%;border:0;border-bottom:1px solid var(--rule);background:transparent;color:var(--text);text-align:left;font:400 .75rem var(--mono);transition:background var(--t)}.evidence-table>button:hover:not(:disabled){background:var(--petal-soft)}.evidence-table i{height:6px;background:var(--s3)}.evidence-table em{display:block;height:100%;background:var(--petal)}.drill{display:flex;align-items:center;justify-content:flex-end;gap:var(--s-1);color:var(--petal-text);font:500 .6875rem var(--sans)}
	.refusal,.canvas-empty,.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:var(--s-1);color:var(--text-3);font-size:.75rem}.refusal{margin:auto;padding:var(--s-3);background:var(--warn-soft);align-items:flex-start;text-align:left}.refusal b,.refusal strong{color:var(--warn-text)}.canvas-empty{min-height:420px}.empty{min-height:180px;padding:var(--s-3)}.empty b,.canvas-empty b{color:var(--text)}.empty-panel{margin:auto;color:var(--text-3);font-size:.75rem}.tree-skeleton,.panel-skeleton{padding:var(--s-3);display:flex;flex-direction:column;gap:var(--s-2)}.tree-skeleton i,.panel-skeleton i{height:32px;background:var(--s2);animation:pulse 1.2s ease-in-out infinite}.tree-skeleton i:nth-child(2){width:82%;margin-left:16px}.tree-skeleton i:nth-child(3){width:70%;margin-left:32px}.panel-skeleton{margin:var(--s-3);min-height:240px;background:var(--s1)}.panel-skeleton i:first-child{width:38%;height:16px}.panel-skeleton i:nth-child(2){height:128px}.panel-skeleton i:last-child{height:12px;width:70%}
	@keyframes replay{from{opacity:.72;transform:translateY(2px)}to{opacity:1;transform:none}}@keyframes pulse{50%{background:var(--s3)}}
	@media(max-width:900px){.investigation{grid-template-columns:220px minmax(0,1fr)}.tree-rail{min-width:0}.node small{display:none}.node{grid-template-columns:20px minmax(0,1fr) 14px}.table-head,.evidence-table>button{grid-template-columns:minmax(100px,1fr) 72px 1fr}.table-head span:nth-child(n+3),.evidence-table>button>span:nth-child(n+3):not(.drill){display:none}}
	@media(max-width:767px){.investigation{display:block}.tree-rail{border-inline-end:0;border-bottom:1px solid var(--rule);max-height:248px;overflow:auto}.node-canvas{display:none}}
	@media(prefers-reduced-motion:reduce){.node,.actions button,.evidence-table>button{transition:none}.panel,.tree-skeleton i,.panel-skeleton i{animation:none}}
</style>
