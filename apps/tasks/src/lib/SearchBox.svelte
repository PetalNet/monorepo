<script>
	import { goto } from "$app/navigation";
	import { rankTasks, highlightChunks } from "$lib/fuzzy.js";
	import Icon from "$lib/Icon.svelte";
	import { who } from "$lib/people.js";
	import { statusClass, kindIcon } from "$lib/status.js";
	// Top-bar instant search (task-506) — Nexus-style typeahead: fuzzy-rank the whole
	// visible corpus locally and surface a live preview dropdown right under the bar.
	// ↑/↓ to move, Enter to open (or see all results), Esc to dismiss, ⌘/Ctrl-K to focus.
	import { onMount } from "svelte";

	let { value = "" } = $props();

	// module-scoped cache so re-mounts (every nav) don't re-fetch the index
	let query = $state((() => value)());
	let open = $state(false);
	let activeIndex = $state(-1);
	let index = $state([]);
	let loading = $state(false);
	let inputEl = $state(null);
	let recents = $state(loadRecents());

	// platform-aware shortcut glyph: ⌘ on Mac, ⌃ (Ctrl) elsewhere. SSR-safe — defaults to ⌃,
	// flips on mount where navigator exists (the handler already accepts both meta + ctrl).
	let modGlyph = $state("⌃");
	onMount(() => {
		const p = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;

		if (/mac/i.test(p)) {
			modGlyph = "⌘";
		}
	});

	const STORAGE_KEY = "tasks:recent-searches";
	const MAX_RECENTS = 6;

	// LEFT indicator: kind icon tinted by status — shared with TaskRow via $lib/status.js

	const results = $derived(query.trim() ? rankTasks(query, index, 8) : []);
	const showRecents = $derived(open && !query.trim() && recents.length > 0);
	const showPanel = $derived(open && (query.trim() ? true : recents.length > 0));

	function loadRecents() {
		if (typeof localStorage === "undefined") {
			return [];
		}

		try {
			return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		} catch {
			return [];
		}
	}
	function addRecent(term) {
		const t = String(term || "").trim();

		if (!t) {
			return;
		}

		recents = [t, ...recents.filter((r) => r !== t)].slice(0, MAX_RECENTS);

		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
		} catch {}
	}

	async function ensureIndex() {
		if (index.length || loading) {
			return;
		}

		loading = true;

		try {
			const r = await fetch("/search/index.json", { headers: { accept: "application/json" } });
			const d = await r.json();

			index = d.items || [];
		} catch {
			index = [];
		}

		loading = false;
	}

	function onFocus() {
		open = true;
		ensureIndex();
	}
	function onInput() {
		open = true;
		activeIndex = -1;
	}

	function openTask(t) {
		addRecent(query.trim());
		close();
		goto(`/task/${t.id}`);
	}
	function seeAll() {
		const q = query.trim();

		if (!q) {
			return;
		}

		addRecent(q);
		close();
		goto(`/search?q=${encodeURIComponent(q)}`);
	}
	function useRecent(term) {
		query = term;
		activeIndex = -1;
		inputEl?.focus();
	}
	function close() {
		open = false;
		activeIndex = -1;
		inputEl?.blur();
	}

	function onKeydown(e) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			open = true;
			const max = results.length - 1;

			activeIndex = Math.min(activeIndex + 1, max);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, -1);
		} else if (e.key === "Enter") {
			e.preventDefault();

			if (activeIndex >= 0 && results[activeIndex]) {
				openTask(results[activeIndex]);
			} else {
				seeAll();
			}
		} else if (e.key === "Escape") {
			e.preventDefault();

			if (query) {
				query = "";
				activeIndex = -1;
			} else {
				close();
			}
		}
	}

	// ⌘/Ctrl-K focuses search from anywhere
	$effect(() => {
		const onWin = (e) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
				e.preventDefault();
				inputEl?.focus();
				inputEl?.select();
			}
		};

		window.addEventListener("keydown", onWin);

		return () => window.removeEventListener("keydown", onWin);
	});
</script>

<div class="sb" role="search">
	{#if open}
		<button class="sb-bd" tabindex="-1" aria-label="Close search" onclick={close}></button>
	{/if}
	<div class="sb-field" class:open={showPanel}>
		<Icon name="search" size={16} />
		<input
			bind:this={inputEl}
			bind:value={query}
			type="search"
			placeholder="Search tasks…"
			aria-label="Search tasks"
			autocomplete="off"
			spellcheck="false"
			role="combobox"
			aria-expanded={showPanel}
			aria-controls="sb-list"
			onfocus={onFocus}
			oninput={onInput}
			onkeydown={onKeydown}
		/>
		<kbd class="sb-kbd">{modGlyph}K</kbd>
	</div>

	{#if showPanel}
		<div class="sb-panel" id="sb-list" role="listbox">
			{#if query.trim()}
				{#if results.length}
					{#each results as t, i (t.id)}
						<button
							class="sb-row"
							class:active={i === activeIndex}
							role="option"
							aria-selected={i === activeIndex}
							onmousemove={() => (activeIndex = i)}
							onclick={() => openTask(t)}
						>
							<span
								class="sb-state st-{statusClass(t.status)}"
								title="{t.kind ?? 'task'} · {t.status}"
								><Icon name={kindIcon(t.kind)} size={15} /></span
							>
							<span class="sb-main">
								<span class="sb-title">
									{#each highlightChunks(t.title, t._hits) as c}{#if c.hit}<mark>{c.text}</mark
											>{:else}{c.text}{/if}{/each}
								</span>
								<span class="sb-meta mono">
									<span>{t.status}</span>
									{#if t.project}<span class="sep">·</span><span>{t.project}</span>{/if}
									{#if t.assignee}<span class="sep">·</span><span>{who(t.assignee)}</span>{/if}
								</span>
							</span>
							<span class="sb-num mono">#{t.id}</span>
						</button>
					{/each}
					<button class="sb-all" onclick={seeAll}>
						<Icon name="search" size={13} />
						See all results for <strong>“{query.trim()}”</strong>
					</button>
				{:else}
					<p class="sb-empty">{loading ? "Searching…" : `No tasks match “${query.trim()}”`}</p>
				{/if}
			{:else if showRecents}
				<p class="sb-grp">Recent</p>
				{#each recents as r}
					<button class="sb-recent" onclick={() => useRecent(r)}>
						<Icon name="search" size={13} />{r}
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.sb {
		position: relative;
		flex: 1;
		max-width: 520px;
	}
	.sb-bd {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: transparent;
		border: 0;
		cursor: default;
	}

	.sb-field {
		position: relative;
		z-index: 41;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 36px;
		padding: 0 10px;
		border-radius: var(--radius);
		background: var(--surface-2);
		border: 1px solid transparent;
		color: var(--text-4);
		transition:
			border-color 0.12s,
			background 0.12s;
	}
	.sb-field:focus-within {
		border-color: var(--border);
		background: var(--surface-1);
		color: var(--text-3);
	}
	/* when the panel is open, square off the bottom so field + panel read as one surface */
	.sb-field.open {
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}
	.sb-field input {
		flex: 1;
		min-width: 0;
		background: none;
		border: 0;
		outline: none;
		font: inherit;
		font-size: 13.5px;
		color: var(--text-1);
	}
	.sb-field input::placeholder {
		color: var(--text-4);
	}
	.sb-field input::-webkit-search-cancel-button {
		-webkit-appearance: none;
	}
	.sb-kbd {
		flex-shrink: 0;
		font-family: var(--mono);
		color: var(--text-4);
		padding: 1px 5px;
		border: 1px solid var(--border-sub);
		border-radius: 5px;
		line-height: 1.5;
	}
	.sb-field:focus-within .sb-kbd {
		display: none;
	}

	.sb-panel {
		position: absolute;
		z-index: 41;
		top: 100%;
		left: 0;
		right: 0;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-top: 1px solid var(--border-sub);
		border-radius: 0 0 var(--radius) var(--radius);
		box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.4);
		overflow: hidden;
		padding: 4px;
	}

	.sb-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
		text-align: left;
		padding: 8px 9px;
		border: 0;
		background: none;
		border-radius: calc(var(--radius) - 4px);
		cursor: pointer;
		color: inherit;
	}
	.sb-row.active {
		background: var(--surface-2);
	}
	.sb-state {
		display: flex;
		align-items: center;
		padding-top: 1px;
		flex-shrink: 0;
	}
	.st-todo {
		color: #94a3b8;
	}
	.st-doing {
		color: var(--accent-b);
	}
	.st-review {
		color: #5eead4;
	}
	.st-blocked {
		color: var(--danger-b);
	}
	.st-done {
		color: #34d399;
	}
	.st-dropped {
		color: var(--text-4);
	}

	.sb-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.sb-title {
		font-size: 13.5px;
		font-weight: 550;
		color: var(--text-1);
		line-height: 1.35;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sb-title mark {
		background: none;
		color: var(--accent-b);
		font-weight: 750;
	}
	.sb-meta {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		color: var(--text-4);
	}
	.sb-meta .sep {
		opacity: 0.55;
	}
	.sb-num {
		flex-shrink: 0;
		align-self: center;
		font-size: 11px;
		color: var(--text-4);
	}

	.sb-all {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		text-align: left;
		margin-top: 2px;
		padding: 8px 9px;
		border: 0;
		border-top: 1px solid var(--border-sub);
		background: none;
		color: var(--text-3);
		font-size: 12px;
		cursor: pointer;
		border-radius: 0;
	}
	.sb-all:hover {
		color: var(--text-1);
	}
	.sb-all strong {
		color: var(--text-2);
		font-weight: 600;
	}

	.sb-empty {
		padding: 14px 10px;
		margin: 0;
		font-size: 12.5px;
		color: var(--text-4);
		text-align: center;
	}
	.sb-grp {
		margin: 4px 4px 2px;
		padding: 4px 6px 0;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--text-4);
	}
	.sb-recent {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		padding: 7px 9px;
		border: 0;
		background: none;
		border-radius: calc(var(--radius) - 4px);
		cursor: pointer;
		color: var(--text-2);
		font-size: 13px;
	}
	.sb-recent:hover {
		background: var(--surface-2);
		color: var(--text-1);
	}
</style>
