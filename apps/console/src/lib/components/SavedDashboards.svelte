<script lang="ts">
	import { browser } from "$app/env";
	import { goto } from "$app/navigation";
	import { dataMode, readDashboards, runOp } from "$lib/rpc/browser";
	import type { DashboardItem } from "$lib/api/types";
	import type { SavedDashboard } from "$lib/data/mock";
	import Icon from "./Icon.svelte";
	import OpButton from "./OpButton.svelte";
	import { opDef } from "$lib/api/ops";
	import { snackbar } from "$lib/stores/snackbar.svelte";

	/** Saved dashboards beneath the ask box (foundations §5.5): dashboards are
	 * Library items (kind: artifact). Empty copy from the lore pack. */
	interface Props {
		items: SavedDashboard[];
		lanes: string[];
		userId: string;
	}
	let { items, lanes, userId }: Props = $props();
	let order = $state<string[]>([]);
	let orderReady = $state(false);
	let details = $state<Record<string, DashboardItem>>({});
	let detailError = $state(false);
	let sharing = $state<string | null>(null);
	let shareSubject = $state("");
	let shareBusy = $state(false);
	let loading = $state<string | null>(null);
	let loadError = $state<{ id: string; message: string } | null>(null);
	const storageKey = $derived(`console:cockpit:dashboards:${userId}`);
	const setHome = opDef("dashboard.set_home")!;
	const remove = opDef("dashboard.delete")!;
	const orderedItems = $derived(items.toSorted((a, b) => {
		const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
		return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
	}));

	$effect(() => {
		if (!browser || orderReady) return;
		try { order = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as string[]; } catch { order = []; }
		orderReady = true;
	});
	$effect(() => {
		if (!browser || dataMode() === "mock") return;
		void readDashboards()
			.then((result) => (details = Object.fromEntries(result.items.map((item) => [item.id, item]))))
			.catch(() => (detailError = true));
	});

	function move(id: string, delta: -1 | 1) {
		const ids = orderedItems.map((item) => item.id);
		const from = ids.indexOf(id), to = from + delta;
		if (to < 0 || to >= ids.length) return;
		[ids[from], ids[to]] = [ids[to], ids[from]];
		order = ids;
		if (browser) localStorage.setItem(storageKey, JSON.stringify(ids));
		snackbar.push({ message: "Dashboard order saved for this cockpit", tone: "good" });
	}

	async function share(id: string) {
		if (!shareSubject.trim()) return;
		shareBusy = true;
		try {
			await runOp("dashboard.share", { id, subject: shareSubject.trim(), relation: "viewer" });
			snackbar.push({ message: "dashboard.share sent", op: "dashboard.share", tone: "good" });
			sharing = null;
			shareSubject = "";
		} catch (error) {
			snackbar.push({ message: `dashboard.share failed: ${(error as Error).message}`, op: "dashboard.share", tone: "danger" });
		} finally { shareBusy = false; }
	}

	async function load(event: MouseEvent, id: string) {
		event.preventDefault();
		const href = `/observability?dashboard=${encodeURIComponent(id)}`;
		if (dataMode() === "mock") {
			await goto(href);
			return;
		}
		loading = id;
		loadError = null;
		try {
			await runOp("dashboard.load", { id });
			await goto(href);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Dashboard load failed";
			loadError = { id, message };
			snackbar.push({ message: `dashboard.load failed: ${message}`, op: "dashboard.load", tone: "danger" });
		} finally {
			loading = null;
		}
	}

	function provenance(d: SavedDashboard) {
		const item = details[d.id];
		if (item) return `created by ${item.created_by} · ${item.scope}`;
		if (dataMode() === "mock") return "fixture · Library artifact";
		return detailError ? "provenance unavailable" : "loading provenance";
	}
</script>

<div class="saved">
	<h3 class="micro">Saved dashboards</h3>
	{#if items.length === 0}
		<p class="empty">No saved dashboards. Ask a question and keep what comes back.</p>
	{:else}
		<div class="saved-row">
			{#each orderedItems as d, index (d.id)}
				<article class="saved-tile" class:loading={loading === d.id} aria-busy={loading === d.id} data-ask="saved dashboard {d.name}">
					<a href="/observability?dashboard={d.id}" aria-label="Load {d.name}" onclick={(event) => void load(event, d.id)}>
						<b>{d.name}</b><span>{d.sub}</span><small>{provenance(d)}</small>
					</a>
					<details class="curate">
						<summary aria-label="Curate {d.name}" title="Dashboard actions"><Icon name="ellipsis" size={16} /></summary>
						<div class="menu">
							<div class="reorder" aria-label="Rearrange dashboard">
								<button disabled={index === 0} aria-label="Move {d.name} earlier" onclick={() => move(d.id, -1)}><Icon name="arrow-left" size={14} />Earlier</button>
								<button disabled={index === orderedItems.length - 1} aria-label="Move {d.name} later" onclick={() => move(d.id, 1)}>Later<Icon name="arrow-right" size={14} /></button>
							</div>
							<OpButton def={setHome} args={{ id: d.id }} {lanes} label="Set as home" />
							{#if lanes.includes("viewer")}
								<button class="menu-action" onclick={() => (sharing = sharing === d.id ? null : d.id)}>Share</button>
							{/if}
							<OpButton def={remove} args={{ id: d.id }} {lanes} variant="danger" />
						</div>
					</details>
					{#if sharing === d.id}
						<form class="share" onsubmit={(event) => { event.preventDefault(); void share(d.id); }}>
							<label for="share-{d.id}">Share with principal or tier</label>
							<div><input id="share-{d.id}" bind:value={shareSubject} placeholder="principal or tier:name" required /><button disabled={shareBusy}>{shareBusy ? "Sharing…" : "Grant view"}</button></div>
							<small>Viewers re-run every panel inside their own scope.</small>
						</form>
					{/if}
					{#if loadError?.id === d.id}<p class="load-error" role="status">Could not load. {loadError.message}</p>{/if}
				</article>
			{/each}
		</div>
	{/if}
</div>

<style>
	.saved {
		margin-top: var(--s-2);
	}
	.micro {
		margin-bottom: var(--s-2);
	}
	.empty {
		font-size: 0.75rem;
		color: var(--text-3);
	}
	.saved-row {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--s-3);
	}
	.saved-tile {
		position: relative;
		background: var(--s1);
		border-radius: var(--r-xs);
		padding: var(--s-2) var(--s-3);
		transition: background var(--t);
		color: inherit;
	}
	.saved-tile:hover {
		background: var(--s2);
	}
	.saved-tile.loading { background: var(--s2); animation: tile-loading 900ms ease-in-out infinite alternate; }
	.saved-tile > a { display: block; color: inherit; text-decoration: none; padding-right: 32px; }
	.saved-tile > a:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; border-radius: var(--r-xs); }
	.saved-tile b {
		font:
			500 0.8125rem var(--sans);
		display: block;
	}
	.saved-tile span {
		font-size: 0.6875rem;
		color: var(--text-3);
		font-family: var(--mono);
	}
	.saved-tile small { display: block; margin-top: var(--s-1); font: 400 0.6875rem var(--mono); color: var(--text-3); }
	.curate { position: absolute; inset: var(--s-1) var(--s-1) auto auto; }
	.curate summary { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--r-sm); color: var(--text-3); cursor: pointer; list-style: none; }
	.curate summary::-webkit-details-marker { display: none; }
	.curate summary:hover, .curate[open] summary { background: var(--s3); color: var(--text); }
	.curate summary:focus-visible, .menu button:focus-visible, .share input:focus-visible, .share button:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	.menu { position: absolute; z-index: var(--z-dropdown); top: 36px; right: 0; width: 184px; display: grid; gap: var(--s-1); padding: var(--s-2); background: var(--s3); border-radius: var(--r-sm); }
	.menu :global(.op-btn), .menu-action { width: 100%; justify-content: flex-start; min-height: 32px; padding: 0 var(--s-2); background: transparent; color: var(--text); font-size: 0.75rem; }
	.menu :global(.op-btn:hover), .menu-action:hover { background: var(--s3); }
	.menu-action, .reorder button { border: 0; border-radius: var(--r-sm); cursor: pointer; font-weight: 500; }
	.reorder { display: flex; border-bottom: 1px solid var(--rule-strong); padding-bottom: var(--s-1); }
	.reorder button { display: inline-flex; align-items: center; gap: var(--s-1); min-height: 32px; background: transparent; color: var(--text-2); font-size: 0.6875rem; }
	.reorder button:disabled { opacity: 0.45; cursor: not-allowed; }
	.share { position: relative; z-index: 1; display: grid; gap: var(--s-1); margin-top: var(--s-2); padding: var(--s-2); background: var(--s2); border-radius: var(--r-xs); }
	.share label, .share small { font: 400 0.6875rem var(--mono); color: var(--text-3); }
	.share div { display: flex; gap: var(--s-1); }
	.share input { min-width: 0; flex: 1; min-height: 32px; border: 0; border-radius: var(--r-sm); padding: 0 var(--s-2); background: var(--bg); color: var(--text); font-size: 0.75rem; }
	.share button { min-height: 32px; border: 0; border-radius: var(--r-sm); padding: 0 var(--s-2); background: var(--petal-fill); color: var(--on-petal); font-weight: 500; }
	.load-error { margin-top: var(--s-2); padding-top: var(--s-2); border-top: 1px solid var(--rule); font-size: 0.6875rem; color: var(--danger-text); }
	@keyframes tile-loading { to { background: var(--s3); } }
	@media (max-width: 640px) {
		.saved-row {
			grid-template-columns: 1fr;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.saved-tile.loading { animation: none; }
	}
</style>
