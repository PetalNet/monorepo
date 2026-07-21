<script lang="ts">
	import {
		groupLibraryKanban,
		KNOWLEDGE_LANES,
		WORK_LANES,
		type KnowledgeLane,
		type WorkLane,
	} from "$lib/data/library-views";
	import type { LibraryItemView } from "$lib/data/library";
	import Icon from "./Icon.svelte";
	import LibraryItemCard from "./LibraryItemCard.svelte";

	interface Props {
		items: LibraryItemView[];
		canUpdate: boolean;
		loading?: boolean;
		onopen: (item: LibraryItemView) => void;
		onstatus: (item: LibraryItemView, status: WorkLane | KnowledgeLane) => Promise<void>;
	}
	let { items, canUpdate, loading = false, onopen, onstatus }: Props = $props();
	let draggedId = $state<string | null>(null);
	let targetLane = $state<string | null>(null);
	let pendingId = $state<string | null>(null);
	const grouped = $derived(groupLibraryKanban(items));

	function beginDrag(event: DragEvent, item: LibraryItemView) {
		if (!canUpdate || pendingId) { event.preventDefault(); return; }
		draggedId = item.id;
		event.dataTransfer?.setData("text/plain", item.id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
	}
	async function move(item: LibraryItemView, lane: WorkLane | KnowledgeLane) {
		if (!canUpdate || item.status === lane || pendingId) return;
		pendingId = item.id;
		try { await onstatus(item, lane); } finally { pendingId = null; draggedId = null; targetLane = null; }
	}
	async function drop(event: DragEvent, lane: WorkLane | KnowledgeLane) {
		event.preventDefault();
		const id = event.dataTransfer?.getData("text/plain") || draggedId;
		const item = items.find((candidate) => candidate.id === id);
		if (item) await move(item, lane);
	}
	function label(lane: string) { return lane === "verified-shared" ? "verified · shared" : lane; }
	function lanesFor(item: LibraryItemView) { return item.kind === "task" ? WORK_LANES : KNOWLEDGE_LANES; }
</script>

<section class="kanban-surface" aria-label="Library status lanes">
	<header><div><h2>Status lanes</h2><p>{canUpdate ? "Drag or use each card’s status control · library.item.update" : "Read-only · Library editor or executor unavailable"}</p></div><span>{items.length} items</span></header>
	{#if grouped.conflicts.length > 0}
		<section class="conflicts" aria-label="Status conflicts requiring adjudication">
			<div class="conflict-sign"><Icon name="triangle-alert" size={16}/><div><h3>Adjudication</h3><p>Two writers disagree. These items never settle into a lane silently.</p></div><strong>{grouped.conflicts.length}</strong></div>
			<div class="conflict-items">{#each grouped.conflicts as item (item.id)}<LibraryItemCard {item} compact {onopen}/>{/each}</div>
		</section>
	{/if}
	{#if grouped.unclassified.length > 0}
		<section class="conflicts unclassified" aria-label="Items with unclassified statuses">
			<div class="conflict-sign"><Icon name="circle-help" size={16}/><div><h3>Needs filing</h3><p>These statuses do not belong to either governed lifecycle.</p></div><strong>{grouped.unclassified.length}</strong></div>
			<div class="conflict-items">{#each grouped.unclassified as item (item.id)}<LibraryItemCard {item} compact {onopen}/>{/each}</div>
		</section>
	{/if}
	{#if loading}
		<div class="board loading" aria-label="Loading status lanes">{#each WORK_LANES as lane, __eachKey9 (__eachKey9)}<section><h3>{lane}</h3><i></i><i></i></section>{/each}</div>
	{:else if items.length === 0}
		<div class="empty"><Icon name="kanban" size={20}/><b>The stacks are open.</b><span>Nothing filed in this scope yet.</span></div>
	{:else}
		<div class="phone-list">{#each items.filter((item) => item.status.toLowerCase() !== "conflict" && !grouped.unclassified.some(({id}) => id === item.id)) as item (item.id)}<article><LibraryItemCard {item} compact {onopen}/><label><span>Status</span><select disabled={!canUpdate || pendingId === item.id} value={item.status} title={canUpdate ? "library.item.update" : "Library status updates unavailable"} onchange={(event) => move(item,(event.currentTarget).value as WorkLane|KnowledgeLane)}>{#each lanesFor(item) as option, __eachKey10 (__eachKey10)}<option value={option}>{label(option)}</option>{/each}</select></label></article>{/each}</div>
		<section class="lifecycle"><div class="group-sign"><h3>Work</h3><p>Task lifecycle</p></div><div class="board">
			{#each WORK_LANES as lane, __eachKey11 (__eachKey11)}
				<section role="group" aria-label={`${label(lane)} work lane`} class:target={targetLane === `work:${lane}`} ondragover={(event) => { if (canUpdate) { event.preventDefault(); targetLane = `work:${lane}`; } }} ondragleave={() => targetLane = null} ondrop={(event) => drop(event,lane)}>
					<header><h4>{label(lane)}</h4><span>{grouped.work[lane].length}</span></header>
					<div class="cards">{#each grouped.work[lane] as item (item.id)}<article draggable={canUpdate} class:dragging={draggedId === item.id} class:pending={pendingId === item.id} ondragstart={(event) => { beginDrag(event,item); }} ondragend={() => { draggedId=null; targetLane=null; }}><LibraryItemCard {item} compact {onopen}/><label><span>Status</span><select disabled={!canUpdate || pendingId === item.id} value={item.status} title={canUpdate ? "library.item.update" : "Library status updates unavailable"} onchange={(event) => move(item,(event.currentTarget).value as WorkLane)}>{#each WORK_LANES as option, __eachKey12 (__eachKey12)}<option value={option}>{label(option)}</option>{/each}</select></label></article>{:else}<p class="lane-empty">All caught up.</p>{/each}</div>
				</section>
			{/each}
		</div></section>
		<section class="lifecycle"><div class="group-sign"><h3>Knowledge</h3><p>Promotion lifecycle</p></div><div class="board">
			{#each KNOWLEDGE_LANES as lane, __eachKey13 (__eachKey13)}
				<section role="group" aria-label={`${label(lane)} knowledge lane`} class:target={targetLane === `knowledge:${lane}`} ondragover={(event) => { if (canUpdate) { event.preventDefault(); targetLane = `knowledge:${lane}`; } }} ondragleave={() => targetLane = null} ondrop={(event) => drop(event,lane)}>
					<header><h4>{label(lane)}</h4><span>{grouped.knowledge[lane].length}</span></header>
					<div class="cards">{#each grouped.knowledge[lane] as item (item.id)}<article draggable={canUpdate} class:dragging={draggedId === item.id} class:pending={pendingId === item.id} ondragstart={(event) => { beginDrag(event,item); }} ondragend={() => { draggedId=null; targetLane=null; }}><LibraryItemCard {item} compact {onopen}/><label><span>Status</span><select disabled={!canUpdate || pendingId === item.id} value={item.status} title={canUpdate ? "library.item.update" : "Library status updates unavailable"} onchange={(event) => move(item,(event.currentTarget).value as KnowledgeLane)}>{#each KNOWLEDGE_LANES as option, __eachKey14 (__eachKey14)}<option value={option}>{label(option)}</option>{/each}</select></label></article>{:else}<p class="lane-empty">All caught up.</p>{/each}</div>
				</section>
			{/each}
		</div></section>
	{/if}
</section>

<style>
	.kanban-surface { margin-top:var(--s-3); animation:view-in 120ms var(--ease-standard); }
	.kanban-surface>header { min-height:48px; display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); border-bottom:1px solid var(--rule); }
	h2 { font:500 .84375rem var(--sans); } p { margin:2px 0 0; color:var(--text-3); font:400 .6875rem var(--mono); }
	.kanban-surface>header>span { font:500 .6875rem var(--mono); color:var(--text-3); }
	.conflicts { margin-top:var(--s-3); background:var(--warn-soft); border-radius:var(--r-xs); }
	.conflicts.unclassified { background:var(--info-soft); }
	.unclassified .conflict-sign,.unclassified .conflict-sign p { color:var(--info-text); }
	.conflict-sign { min-height:48px; display:flex; align-items:center; gap:var(--s-2); padding:var(--s-2) var(--s-3); color:var(--warn-text); }
	.conflict-sign h3 { font:500 .75rem var(--mono); text-transform:uppercase; } .conflict-sign p { color:var(--warn-text); } .conflict-sign strong { margin-left:auto; font:500 .75rem var(--mono); }
	.conflict-items { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:var(--s-1); padding:0 var(--s-2) var(--s-2); }
	.lifecycle { margin-top:var(--s-3); display:grid; grid-template-columns:104px minmax(0,1fr); gap:var(--s-2); }
	.group-sign { padding:var(--s-2) 0; } .group-sign h3 { font:500 .75rem var(--mono); text-transform:uppercase; color:var(--text-2); }
	.board { display:grid; grid-template-columns:repeat(4,minmax(190px,1fr)); gap:var(--s-2); overflow-x:auto; padding-bottom:var(--s-2); }
	.board>section { min-height:176px; background:var(--s2); border-radius:var(--r-xs); transition:background 120ms var(--ease-standard), box-shadow 120ms var(--ease-standard); }
	.board>section.target { background:var(--petal-wash); box-shadow:inset 0 0 0 2px var(--petal-ln); }
	.board>section>header { min-height:40px; display:flex; align-items:center; justify-content:space-between; padding:0 var(--s-2); border-bottom:1px solid var(--rule); }
	h4 { font:500 .6875rem var(--mono); text-transform:uppercase; color:var(--text-2); }
	.board>section>header span { min-width:20px; height:20px; display:grid; place-items:center; border-radius:var(--r-pill); background:var(--s3); color:var(--text-3); font:500 .6875rem var(--mono); }
	.cards { padding:var(--s-1); } article { position:relative; background:var(--s1); border-radius:var(--r-xs); margin-bottom:var(--s-1); transition:opacity 120ms var(--ease-standard), transform 120ms var(--ease-standard); }
	article[draggable="true"] { cursor:grab; } article.dragging { opacity:.5; transform:scale(.98); } article.pending { opacity:.58; }
	article label { display:flex; align-items:center; justify-content:space-between; gap:var(--s-1); padding:0 var(--s-1) var(--s-1) var(--s-2); }
	article label>span { color:var(--text-3); font:400 .6875rem var(--mono); }
	select { min-height:32px; max-width:132px; border:0; border-radius:var(--r-sm); padding:0 var(--s-2); background:var(--s2); color:var(--text-2); font:500 .6875rem var(--mono); }
	select:focus-visible { outline:2px solid var(--petal); outline-offset:2px; } select:disabled { opacity:.55; }
	.lane-empty { padding:var(--s-3) var(--s-2); }
	.loading section i { display:block; height:48px; margin:var(--s-2); background:var(--s3); animation:pulse 1.2s ease-in-out infinite alternate; }
	.empty { min-height:320px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--s-1); color:var(--text-3); } .empty b { color:var(--text-2); font-size:.8125rem; }
	.phone-list { display:none; }
	@keyframes pulse { to { opacity:.45; } }
	@keyframes view-in { from { opacity:.72; } }
	@media (max-width:900px) { .lifecycle { grid-template-columns:1fr; } .group-sign { display:flex; align-items:baseline; gap:var(--s-2); padding-bottom:0; } }
	@media (max-width:767px) { .lifecycle { display:none; } .phone-list { display:block; background:var(--s1); padding:var(--s-2); margin-top:var(--s-2); } .phone-list article { background:var(--s2); margin-bottom:var(--s-1); } }
	@media (prefers-reduced-motion:reduce) { .kanban-surface,.board>section,article { animation:none; transition:none; } .loading section i { animation:none; } }
</style>
