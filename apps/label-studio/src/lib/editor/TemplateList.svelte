<script lang="ts">
	import Banner from "$lib/ui/Banner.svelte";
	import Button from "$lib/ui/Button.svelte";
	import Skeleton from "$lib/ui/Skeleton.svelte";
	import TapeLabel from "$lib/ui/TapeLabel.svelte";
	import { templates } from "$lib/ui/templates.svelte";
	import { Search } from "@lucide/svelte";

	import { editor } from "./editor.svelte";

	/** The compact template list in the editor's side panel. */
	let query = $state("");
	void templates.ensure();

	const shown = $derived(
		templates.list.filter((template) =>
			`${template.name} ${template.description} ${template.category}`
				.toLowerCase()
				.includes(query.trim().toLowerCase()),
		),
	);
</script>

<div class="list">
	<label class="search">
		<Search aria-hidden="true" />
		<span class="sr-only">Search templates</span>
		<input type="search" placeholder="Search templates" bind:value={query} autocomplete="off" />
	</label>
	{#if templates.load.kind === "failed"}
		<Banner tone="danger">
			{templates.load.message}
			{#snippet action()}<Button size="sm" onclick={() => templates.refresh()}>Retry</Button
				>{/snippet}
		</Banner>
	{:else if templates.load.kind !== "ready"}
		{#each { length: 5 }, index (index)}
			<div class="item"><Skeleton height="40px" /><Skeleton width="60%" height="12px" /></div>
		{/each}
	{:else if shown.length === 0}
		<p class="hint">No template matches "{query}".</p>
	{:else}
		{#each shown as template (template.id)}
			<button
				type="button"
				class="item"
				class:current={editor.template?.id === template.id}
				onclick={() => {
					editor.loadTemplate(template);
				}}
			>
				<TapeLabel
					doc={template.doc}
					vars={{}}
					maxWidth={232}
					maxHeight={40}
					dimension={false}
					lazy
				/>
				<span class="name">{template.name}</span>
			</button>
		{/each}
	{/if}
</div>

<style>
	.list {
		display: grid;
		gap: 4px;
	}

	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		margin-bottom: 8px;
		padding-inline: 10px;
		border-radius: var(--r);
		background: var(--sunken);
	}

	.search:focus-within {
		outline: 2px solid var(--accent);
	}

	.search :global(svg) {
		width: 15px;
		height: 15px;
		color: var(--ink-3);
	}

	input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		outline: none;
	}

	.item {
		display: grid;
		justify-items: start;
		gap: 8px;
		padding: 12px 8px 8px;
		border: 0;
		border-radius: var(--r);
		background: transparent;
		color: var(--ink);
		text-align: start;
		cursor: pointer;
		transition: background-color var(--fast);
	}

	.item:hover {
		background: var(--hover);
	}

	.item.current {
		background: var(--accent-soft);
	}

	.name {
		font-size: 13px;
	}

	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}
</style>
