<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		label,
		for: htmlFor,
		children,
	}: { label: string; for?: string; children: Snippet } = $props();
</script>

<div class="row">
	{#if htmlFor}
		<label class="label" for={htmlFor}>{label}</label>
	{:else}
		<span class="label">{label}</span>
	{/if}
	<div class="control">{@render children()}</div>
</div>

<style>
	.row {
		display: grid;
		grid-template-columns: 88px minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		min-height: 32px;
	}

	.label {
		color: var(--ink-2);
		font-size: 13px;
	}

	.control {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
</style>
