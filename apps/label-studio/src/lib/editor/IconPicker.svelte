<script lang="ts">
	import Skeleton from "$lib/ui/Skeleton.svelte";
	import { Icon as LucideIcon, Search } from "@lucide/svelte";
	import type { IconNode } from "@lucide/svelte";

	import { loadIcons, searchIcons, type IconEntry } from "./icons";

	let { onpick, current }: { onpick: (name: string) => void; current?: string } = $props();

	let query = $state("");
	let entries = $state.raw<IconEntry[] | null>(null);
	let failed = $state(false);
	const results = $derived(entries ? searchIcons(entries, query) : []);

	loadIcons().then(
		(loaded) => {
			entries = loaded;
		},
		() => {
			failed = true;
		},
	);
</script>

<div class="picker">
	<label class="search">
		<Search aria-hidden="true" />
		<span class="sr-only">Search icons</span>
		<input
			type="search"
			placeholder="Search 1,600 icons"
			bind:value={query}
			autocomplete="off"
			spellcheck="false"
		/>
	</label>
	{#if failed}
		<p class="empty">Icons failed to load. Reload to try again.</p>
	{:else if !entries}
		<div class="grid">
			{#each { length: 24 }, index (index)}<Skeleton height="44px" />{/each}
		</div>
	{:else if results.length === 0}
		<p class="empty">No icon called "{query}". Try a broader word, like "arrow" or "food".</p>
	{:else}
		<div class="grid" role="listbox" aria-label="Icons">
			{#each results as entry (entry.name)}
				<button
					type="button"
					role="option"
					aria-selected={entry.name === current}
					title={entry.name}
					onclick={() => {
						onpick(entry.name);
					}}
				>
					<LucideIcon iconNode={entry.node as IconNode} size={22} strokeWidth={1.75} />
					<span class="sr-only">{entry.name}</span>
				</button>
			{/each}
		</div>
		{#if query === ""}<p class="hint">Common label icons. Search for the rest.</p>{/if}
	{/if}
</div>

<style>
	.picker {
		display: grid;
		gap: 10px;
	}

	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 36px;
		padding-inline: 10px;
		border-radius: var(--r);
		background: var(--sunken);
	}

	.search:focus-within {
		outline: 2px solid var(--accent);
	}

	.search :global(svg) {
		width: 16px;
		height: 16px;
		color: var(--ink-3);
	}

	input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		outline: none;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
		gap: 4px;
		max-height: 320px;
		overflow: auto;
	}

	button {
		display: grid;
		place-items: center;
		height: 44px;
		border: 0;
		border-radius: var(--r);
		background: transparent;
		color: var(--ink);
		cursor: pointer;
		transition: background-color var(--fast);
	}

	button:hover {
		background: var(--hover);
	}

	button[aria-selected="true"] {
		background: var(--accent-soft);
		color: var(--accent-text);
	}

	.empty,
	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}
</style>
