<script lang="ts">
	import { clock } from "#lib/format.ts";

	/** Where a reading comes from and when it was last checked. Every instrument ends with one. */
	let {
		sources,
		checkedAt,
	}: {
		sources: readonly { label: string; href: string }[];
		checkedAt: string | undefined;
	} = $props();
</script>

<p class="source">
	<span>
		{sources.length > 1 ? "Sources" : "Source"}:
		{#each sources as { label, href } (href)}
			<a {href} rel="external noreferrer">{label}</a>
		{/each}
	</span>
	<span>
		{#if checkedAt}
			Last checked <time datetime={checkedAt}>{clock(checkedAt)}</time>
		{:else}
			Not checked yet
		{/if}
	</span>
</p>

<style>
	a + a {
		margin-inline-start: 0.75em;
	}
	.source {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.5rem;
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
</style>
