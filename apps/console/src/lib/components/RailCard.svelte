<script lang="ts">
	import type { Snippet } from "svelte";

	/** A cockpit rail card (shell chrome, NOT an assistant Panel): 2px radius per
	 * §3.4 — the 12px softness is reserved for agent-composed Panels. */
	interface Props {
		heading: string;
		sign?: string | null;
		children: Snippet;
	}
	let { heading, sign = null, children }: Props = $props();
</script>

<div class="rail-card">
	<div class="pin-head">
		<h3 class="micro">{heading}</h3>
		{#if sign}<span class="sign-sub">{sign}</span>{/if}
	</div>
	{@render children()}
</div>

<style>
	.rail-card {
		background: var(--s1);
		border-radius: var(--r-xs);
		padding: var(--s-3);
	}
	.pin-head {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		margin-bottom: var(--s-2);
	}
	.sign-sub {
		font:
			400 0.8125rem var(--sign);
		color: var(--text-3);
	}
</style>
