<script lang="ts">
	import { buildLibraryGraph, nextGraphNode } from "$lib/data/library-views";
	import type { LibraryItemView, LibraryLinkFixture } from "$lib/data/library";
	import Icon from "./Icon.svelte";
	import LibraryItemCard from "./LibraryItemCard.svelte";

	interface Props {
		items: LibraryItemView[];
		links: Record<string, LibraryLinkFixture[]>;
		degraded?: boolean;
		loading?: boolean;
		onopen: (item: LibraryItemView) => void;
	}
	let { items, links, degraded = false, loading = false, onopen }: Props = $props();
	let viewport = $state<HTMLDivElement | null>(null);
	let scale = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let focusedId = $state<string | null>(null);
	let dragging = $state(false);
	let pointer = $state({ id: -1, x: 0, y: 0 });
	const graph = $derived(buildLibraryGraph(items, links));
	const nodeById = $derived(new Map(graph.nodes.map((node) => [node.id, node])));
	const neighbors = $derived(new Set(focusedId ? (links[focusedId] ?? []).map(({ targetId }) => targetId) : []));
	const icons = { task:"circle-check", project:"folder", doc:"file-text", artifact:"package", research:"microscope", fact:"quote", decision:"milestone", "how-to":"list-ordered" } as const;

	function clampScale(value: number) { return Math.min(1.8, Math.max(.55, value)); }
	function zoom(delta: number) { scale = clampScale(scale + delta); }
	function reset() { scale = 1; panX = 0; panY = 0; }
	function wheel(event: WheelEvent) {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		zoom(event.deltaY > 0 ? -.1 : .1);
	}
	function startPan(event: PointerEvent) {
		if (event.button !== 0 || event.target instanceof HTMLButtonElement) return;
		dragging = true;
		pointer = { id:event.pointerId, x:event.clientX, y:event.clientY };
		viewport?.setPointerCapture(event.pointerId);
	}
	function movePan(event: PointerEvent) {
		if (!dragging || event.pointerId !== pointer.id) return;
		panX += event.clientX - pointer.x;
		panY += event.clientY - pointer.y;
		pointer = { ...pointer, x:event.clientX, y:event.clientY };
	}
	function endPan(event: PointerEvent) {
		if (event.pointerId !== pointer.id) return;
		dragging = false;
		viewport?.releasePointerCapture(event.pointerId);
	}
	function walk(event: KeyboardEvent, id: string) {
		const directions: Partial<Record<string, "left" | "right" | "up" | "down">> = { ArrowLeft:"left", ArrowRight:"right", ArrowUp:"up", ArrowDown:"down" };
		const direction = directions[event.key];
		if (!direction) return;
		const next = nextGraphNode(id, direction, links);
		if (!next) return;
		event.preventDefault();
		viewport?.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(next)}"]`)?.focus();
	}
	function edgePath(fromId: string, toId: string) {
		const from = nodeById.get(fromId); const to = nodeById.get(toId);
		if (!from || !to) return "";
		const bend = Math.max(48, (to.x - from.x) * .48);
		return `M ${String(from.x + 20)} ${String(from.y)} C ${String(from.x + bend)} ${String(from.y)}, ${String(to.x - bend)} ${String(to.y)}, ${String(to.x - 20)} ${String(to.y)}`;
	}
</script>

<section class="graph-surface" aria-label="Typed-link dependency graph">
	<header>
		<div><h2>Dependency graph</h2><p>{items.length} scope-filtered items · arrows walk typed links</p></div>
		<div class="graph-controls" aria-label="Graph zoom controls">
			<button onclick={() => { zoom(-.15); }} aria-label="Zoom out"><Icon name="zoom-out" size={15}/></button>
			<output aria-live="polite">{Math.round(scale * 100)}%</output>
			<button onclick={() => { zoom(.15); }} aria-label="Zoom in"><Icon name="zoom-in" size={15}/></button>
			<button onclick={reset} aria-label="Reset graph position"><Icon name="locate-fixed" size={15}/></button>
		</div>
	</header>
	{#if degraded}<p class="degraded"><Icon name="triangle-alert" size={14}/>Link index is stale. Relationships are last-known and drawn dashed.</p>{/if}
	{#if loading}
		<div class="graph-loading" aria-label="Loading dependency graph">{#each Array.from({ length: 7 }, (_, index) => index) as index (index)}<span style={`left:${String(8+(index%4)*23)}%;top:${String(16+Math.floor(index/4)*40)}%`}></span>{/each}</div>
	{:else if items.length === 0}
		<div class="empty"><Icon name="git-branch" size={20}/><b>The stacks are open.</b><span>Nothing filed in this scope yet.</span></div>
	{:else}
		<div class="phone-list">{#each items as item (item.id)}<LibraryItemCard {item} compact {onopen}/>{/each}</div>
		<div bind:this={viewport} class:dragging class="viewport" role="group" aria-label="Pan and zoom dependency graph" onwheel={wheel} onpointerdown={startPan} onpointermove={movePan} onpointerup={endPan} onpointercancel={endPan}>
			<div class="canvas" style={`width:${String(graph.width)}px;height:${String(graph.height)}px;transform:translate(${String(panX)}px,${String(panY)}px) scale(${String(scale)})`}>
				<svg width={graph.width} height={graph.height} aria-hidden="true">
					<defs><marker id="library-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z"/></marker></defs>
					{#each graph.edges as edge (`${edge.from}-${edge.to}-${edge.rel}`)}
						<g class:active={focusedId === edge.from || focusedId === edge.to}>
							<path class:stale={degraded} d={edgePath(edge.from, edge.to)} marker-end="url(#library-arrow)"/>
							<text x={(nodeById.get(edge.from)?.x ?? 0) + 104} y={((nodeById.get(edge.from)?.y ?? 0) + (nodeById.get(edge.to)?.y ?? 0))/2 - 7}>{edge.rel}</text>
						</g>
					{/each}
				</svg>
				{#each graph.nodes as node (node.id)}
					<button data-node-id={node.id} class="node {node.kind}" class:neighbor={neighbors.has(node.id)} class:focused={focusedId === node.id} style={`left:${String(node.x)}px;top:${String(node.y)}px`} title={node.title} onclick={() => { onopen(node); }} onfocus={() => focusedId = node.id} onblur={() => focusedId = null} onkeydown={(event) => { walk(event,node.id); }} aria-label={`${node.title}, ${node.kind}, ${node.status}`}>
						<span class="node-icon"><Icon name={icons[node.kind]} size={16}/></span><span class="node-title">{node.title}</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}
</section>

<style>
	.graph-surface { margin-top:var(--s-3); background:var(--s1); border-radius:var(--r-xs); overflow:hidden; animation:view-in 120ms var(--ease-standard); }
	header { min-height:56px; padding:var(--s-2) var(--s-3); border-bottom:1px solid var(--rule); display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); }
	h2 { font:500 .84375rem var(--sans); } p { margin:2px 0 0; font:400 .6875rem var(--mono); color:var(--text-3); }
	.graph-controls { display:flex; align-items:center; gap:var(--s-1); background:var(--s2); border-radius:var(--r-sm); padding:var(--s-1); }
	.graph-controls button { width:32px; height:32px; display:grid; place-items:center; border:0; border-radius:var(--r-sm); background:transparent; color:var(--text-2); }
	.graph-controls button:hover { background:var(--s3); color:var(--text); }
	.graph-controls button:focus-visible,.node:focus-visible { outline:2px solid var(--petal); outline-offset:2px; }
	.graph-controls output { min-width:40px; text-align:center; font:500 .6875rem var(--mono); color:var(--text-2); }
	.degraded { margin:0; padding:var(--s-2) var(--s-3); display:flex; align-items:center; gap:var(--s-2); color:var(--warn-text); background:var(--warn-soft); }
	.viewport { height:min(64vh,640px); min-height:480px; overflow:hidden; position:relative; cursor:grab; touch-action:none; background:var(--s1); }
	.viewport.dragging { cursor:grabbing; }
	.canvas { position:absolute; transform-origin:0 0; transition:transform 120ms var(--ease-standard); }
	svg { position:absolute; inset:0; overflow:visible; }
	svg path { fill:none; stroke:var(--text-3); stroke-width:1.25; vector-effect:non-scaling-stroke; }
	svg path.stale { stroke-dasharray:5 4; }
	svg marker path { fill:var(--text-3); stroke:none; }
	svg text { fill:var(--text-2); font:500 11px var(--mono); opacity:0; transition:opacity 120ms var(--ease-standard); paint-order:stroke; stroke:var(--s1); stroke-width:4px; }
	svg g:hover text,svg g.active text { opacity:1; } svg g.active path { stroke:var(--petal-text); }
	.node { position:absolute; width:152px; min-height:72px; transform:translate(-20px,-36px); border:0; background:transparent; color:var(--text); padding:0; text-align:left; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; border-radius:var(--r-xs); transition:background 120ms var(--ease-standard), transform 120ms var(--ease-standard); }
	.node:hover,.node.neighbor { background:var(--s2); transform:translate(-20px,-38px); }
	.node-icon { width:32px; height:32px; display:grid; place-items:center; border-radius:var(--r-pill); background:var(--bg); color:var(--info-text); box-shadow:inset 0 0 0 2px var(--info-dot); }
	.node.task .node-icon,.node.project .node-icon { color:var(--petal-text); box-shadow:inset 0 0 0 2px var(--petal); }
	.node.artifact .node-icon { color:var(--jade-text); box-shadow:inset 0 0 0 2px var(--jade); }
	.node.research .node-icon { color:var(--research-text); box-shadow:inset 0 0 0 2px var(--research-text); }
	.node.decision .node-icon { color:var(--warn-text); box-shadow:inset 0 0 0 2px var(--warn-dot); }
	.node.focused .node-icon { outline:2px solid var(--petal); outline-offset:3px; }
	.node-title { width:144px; margin-top:var(--s-1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:500 .6875rem var(--mono); }
	.graph-loading { min-height:480px; position:relative; } .graph-loading span { position:absolute; width:32px; height:32px; border-radius:var(--r-pill); background:var(--s3); animation:pulse 1.2s ease-in-out infinite alternate; }
	.empty { min-height:320px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--s-1); color:var(--text-3); } .empty b { color:var(--text-2); font-size:.8125rem; }
	.phone-list { display:none; }
	@keyframes pulse { to { opacity:.45; } }
	@keyframes view-in { from { opacity:.72; } }
	@media (max-width:767px) { header { align-items:flex-start; } .graph-controls { display:none; } .viewport { display:none; } .phone-list { display:block; padding:var(--s-2); } }
	@media (prefers-reduced-motion:reduce) { .graph-surface,.canvas,.node,svg text { animation:none; transition:none; } .graph-loading span { animation:none; } }
</style>
