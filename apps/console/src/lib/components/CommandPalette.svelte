<script lang="ts">
	import { goto } from "$app/navigation";
	import { searchCommandPalette } from "$lib/command-palette.remote";
	import type { PaletteItem, PaletteKind, PaletteSearchResponse } from "$lib/data/palette";
	import { visibleNav } from "$lib/nav";
	import { Effect } from "effect";
	import Icon from "./Icon.svelte";
	import ModalSurface from "./ModalSurface.svelte";

	interface Props {
		lanes: string[];
		connected?: boolean;
		onask: () => void;
		open?: boolean;
	}
	let { lanes, connected = true, onask, open = $bindable(false) }: Props = $props();

	let dialog = $state<HTMLDialogElement | null>(null);
	let input = $state<HTMLInputElement | null>(null);
	let text = $state("");
	let remote = $state<PaletteSearchResponse | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	let selected = $state(0);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let requestId = 0;

	const iconByKind: Record<PaletteKind, string> = {
		action: "sparkles",
		surface: "arrow-right",
		agent: "users-round",
		task: "kanban",
		library: "book-open",
		host: "server",
		statistic: "chart-line",
	};

	const actions = $derived<PaletteItem[]>([
		{ id: "action:ask", kind: "action", label: "Ask Janet", description: "Focus the assistant", meta: "/" },
		{ id: "action:attention", kind: "action", label: "Show what needs me", description: "Open Cockpit attention", href: "/#attention", meta: "G C" },
		{ id: "action:review", kind: "action", label: "Review ready work", description: "Open review lane", href: "/work#review", meta: "G W" },
		{ id: "action:library", kind: "action", label: "Search the Library", description: "Open the one store", href: "/library?focus=search", meta: "G L" },
	]);

	const surfaces = $derived<PaletteItem[]>(
		visibleNav(lanes).map((entry) => ({
			id: `surface:${entry.href}`,
			kind: "surface" as const,
			label: entry.label,
			description: entry.sign ?? (entry.href === "/" ? "Landing dashboard" : `Open ${entry.label}`),
			href: entry.href,
			...(entry.key ? { meta: `G ${entry.key.toUpperCase()}` } : {}),
		})),
	);

	function localMatch(item: PaletteItem, queryText: string): boolean {
		const words = queryText.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
		const value = `${item.label} ${item.description} ${item.meta ?? ""}`.toLocaleLowerCase();
		return words.every((word) => {
			if (value.includes(word)) return true;
			let cursor = 0;
			for (const character of word) {
				cursor = value.indexOf(character, cursor);
				if (cursor < 0) return false;
				cursor += 1;
			}
			return true;
		});
	}

	const local = $derived.by(() => {
		if (!text.trim()) return [...actions, ...surfaces];
		return [...actions, ...surfaces].filter((item) => localMatch(item, text));
	});
	const items = $derived([...local, ...(remote?.items ?? [])]);
	const unavailable = $derived(
		remote ? Object.entries(remote.sources).filter(([, state]) => state === "unavailable").map(([source]) => source) : [],
	);

	$effect(() => {
		if (!open) return;
		selected = 0;
		queueMicrotask(() => input?.focus());
	});

	function close() {
		open = false;
		text = "";
		remote = null;
		failed = false;
		loading = false;
		if (timer) clearTimeout(timer);
		requestId += 1;
	}

	function queueSearch() {
		selected = 0;
		remote = null;
		failed = false;
		if (timer) clearTimeout(timer);
		const queryText = text.trim();
		if (!queryText) {
			loading = false;
			return;
		}
		loading = true;
		const current = ++requestId;
		timer = setTimeout(() => void (async () => {
			try {
				const result = await Effect.runPromise(searchCommandPalette({ query: queryText }));
				if (current === requestId) remote = result;
			} catch {
				if (current === requestId) failed = true;
			} finally {
				if (current === requestId) loading = false;
			}
		})(), 120);
	}

	async function choose(item: PaletteItem) {
		dialog?.close();
		if (item.id === "action:ask") {
			// ModalSurface restores the opener in a microtask; focus Janet immediately after it.
			setTimeout(onask, 0);
			return;
		}
		if (item.href) await goto(item.href);
	}

	function listKey(event: KeyboardEvent) {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			selected = items.length ? (selected + 1) % items.length : 0;
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			selected = items.length ? (selected - 1 + items.length) % items.length : 0;
		} else if (event.key === "Enter" && items[selected]) {
			event.preventDefault();
			void choose(items[selected]);
		}
		queueMicrotask(() => document.getElementById(`palette-option-${String(selected)}`)?.scrollIntoView({ block: "nearest" }));
	}
</script>

<ModalSurface bind:element={dialog} {open} variant="palette" labelledby="command-palette-title" onclose={close}>
	<div class="palette-shell">
		<h2 id="command-palette-title" class="sr-only">Search the console and run a quick action</h2>
		<label class="search-row">
			<Icon name="search" size={20} />
			<input
				bind:this={input}
				bind:value={text}
				role="combobox"
				aria-label="Search surfaces, objects, and agents"
				aria-controls="command-palette-results"
				aria-expanded="true"
				aria-activedescendant={items[selected] ? `palette-option-${String(selected)}` : undefined}
				placeholder="Search surfaces, objects, and agents"
				maxlength="100"
				oninput={queueSearch}
				onkeydown={listKey}
			/>
			<kbd>⌘ K</kbd>
		</label>

		<div id="command-palette-results" class="results" role="listbox" aria-label="Command palette results">
			{#if !text.trim()}
				<p class="group-label">Quick actions and surfaces</p>
			{:else if local.length > 0}
				<p class="group-label">Commands</p>
			{/if}
			{#each items as item, index (item.id)}
				{#if index === local.length && remote?.items.length}
					<p class="group-label object-label">Objects</p>
				{/if}
				<button
					id={`palette-option-${String(index)}`}
					type="button"
					role="option"
					aria-selected={index === selected}
					class:selected={index === selected}
					onpointermove={() => (selected = index)}
					onclick={() => choose(item)}
				>
					<span class="result-icon"><Icon name={iconByKind[item.kind]} size={16} /></span>
					<span class="result-copy"><b>{item.label}</b><small>{item.description}</small></span>
					{#if item.meta}<span class="meta">{item.meta}</span>{/if}
					<Icon name="arrow-right" size={14} />
				</button>
			{/each}

			{#if loading}
				<div class="loading" role="status" aria-live="polite"><span></span><span></span><span></span><em>Searching visible objects</em></div>
			{:else if failed || (!connected && text.trim())}
				<div class="message warn" role="status"><Icon name="circle-help" size={16} /><span>Object search is unavailable. Surfaces and quick actions still work.</span></div>
			{:else if text.trim() && items.length === 0}
				<div class="message" role="status"><Icon name="search" size={16} /><span>No visible matches. Try an agent handle, task number, host, or surface.</span></div>
			{/if}
			{#if unavailable.length > 0 && !loading}
				<p class="source-note">Partial results · {unavailable.join(", ")} unavailable</p>
			{/if}
		</div>

		<footer><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span><span class="scope">Only objects in your scope appear.</span></footer>
	</div>
</ModalSurface>

<style>
	.palette-shell { display: flex; flex-direction: column; max-height: inherit; min-height: 360px; }
	.search-row { height: 64px; display: flex; align-items: center; gap: var(--s-3); padding: 0 var(--s-4); border-bottom: 1px solid var(--rule); background: var(--s1); }
	.search-row :global(svg) { color: var(--jade); flex: none; }
	.search-row input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: 400 1rem/1.4 var(--sans); }
	.search-row input::placeholder { color: var(--text-3); opacity: 1; }
	kbd { min-width: 24px; height: 24px; padding: 0 var(--s-1); display: inline-grid; place-items: center; border-radius: var(--r-xs); background: var(--s2); color: var(--text-2); box-shadow: inset 0 0 0 1px var(--rule-strong); font: 500 .6875rem var(--mono); }
	.results { flex: 1; min-height: 0; overflow: auto; padding: var(--s-2); scroll-padding-block: 32px; }
	.group-label { margin: var(--s-1) var(--s-2); color: var(--text-3); font: 500 .6875rem var(--mono); letter-spacing: .04em; }
	.object-label { margin-top: var(--s-3); padding-top: var(--s-2); border-top: 1px solid var(--rule); }
	.results > button { width: 100%; min-height: 48px; display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2); border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); text-align: left; transition: background var(--t), transform var(--t-fast); }
	.results > button.selected { background: var(--petal-soft); }
	.results > button:active { transform: scale(.995); }
	.results > button:focus-visible { outline: 2px solid var(--petal); outline-offset: 0; }
	.result-icon { width: 32px; height: 32px; display: grid; place-items: center; flex: none; border-radius: var(--r-sm); background: var(--s2); color: var(--text-2); }
	.selected .result-icon { background: color-mix(in srgb, var(--petal) 14%, var(--s1)); color: var(--petal-text); }
	.result-copy { flex: 1; min-width: 0; }
	.result-copy b, .result-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.result-copy b { font: 500 .8125rem var(--sans); }
	.result-copy small { margin-top: 2px; color: var(--text-3); font: 400 .6875rem var(--sans); }
	.meta { max-width: 128px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); font: 400 .6875rem var(--mono); }
	.results > button > :global(svg) { color: var(--text-3); flex: none; opacity: 0; transform: translateX(-2px); transition: opacity var(--t), transform var(--t); }
	.results > button.selected > :global(svg) { opacity: 1; transform: none; }
	.loading { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s-2); padding: var(--s-2); }
	.loading span { height: 48px; border-radius: var(--r-sm); background: var(--s2); animation: sheen 1.2s ease-in-out infinite alternate; }
	.loading span:nth-child(2) { animation-delay: 80ms; }.loading span:nth-child(3) { animation-delay: 160ms; }
	.loading em { grid-column: 1/-1; color: var(--text-3); font: 400 .6875rem var(--mono); }
	.message { min-height: 96px; display: flex; align-items: center; justify-content: center; gap: var(--s-2); padding: var(--s-4); color: var(--text-3); font-size: .8125rem; }
	.message.warn { color: var(--warn-text); }
	.source-note { padding: var(--s-2); color: var(--warn-text); font: 400 .6875rem var(--mono); }
	footer { min-height: 40px; display: flex; align-items: center; gap: var(--s-3); padding: 0 var(--s-4); border-top: 1px solid var(--rule); background: var(--s1); color: var(--text-3); font: 400 .6875rem var(--sans); }
	footer span { display: inline-flex; align-items: center; gap: var(--s-1); } footer kbd { min-width: 20px; height: 20px; }
	.scope { margin-inline-start: auto; }
	@keyframes sheen { from { opacity: .55; } to { opacity: 1; } }
	@media (max-width: 767px) {
		.palette-shell { min-height: 100dvh; }
		.search-row { height: 56px; padding: 0 var(--s-3); }
		.search-row > kbd, footer .scope { display: none; }
		.results { padding: var(--s-1); }
		.results > button { min-height: 56px; }
		.meta { max-width: 88px; }
		footer { padding: 0 var(--s-3); }
	}
	@media (prefers-reduced-motion: reduce) {
		.loading span { animation: none; }
		.results > button, .results > button > :global(svg) { transition: none; }
	}
</style>
