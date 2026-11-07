<script lang="ts">
	import { CircleAlert, Info, TriangleAlert } from "@lucide/svelte";
	import type { Snippet } from "svelte";

	let {
		tone = "info",
		children,
		action,
	}: { tone?: "info" | "warn" | "danger"; children: Snippet; action?: Snippet } = $props();
</script>

<div class="banner {tone}" role={tone === "danger" ? "alert" : "status"}>
	{#if tone === "danger"}
		<CircleAlert aria-hidden="true" />
	{:else if tone === "warn"}
		<TriangleAlert aria-hidden="true" />
	{:else}
		<Info aria-hidden="true" />
	{/if}
	<div class="body">{@render children()}</div>
	{#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
	.banner {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 12px;
		border-radius: var(--r);
		font-size: 13px;
		animation: enter var(--base) var(--ease);
	}

	.banner > :global(svg) {
		flex: none;
		width: 16px;
		height: 16px;
		margin-top: 1px;
	}

	.body {
		flex: 1;
		min-width: 0;
	}

	.action {
		flex: none;
		margin-block: -4px;
	}

	.info {
		background: var(--sunken);
		color: var(--ink-2);
	}

	.warn {
		background: var(--warn-soft);
		color: var(--warn);
	}

	.danger {
		background: var(--danger-soft);
		color: var(--danger);
	}

	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}
</style>
