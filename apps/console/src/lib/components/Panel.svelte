<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";

	/**
	 * Panel (foundations §3.7/§5.4): the assistant-composed canvas tile. The ONE
	 * 12px-radius exception (§3.4) — panels earn the softness as the agent's own
	 * artifacts. No panel exists without its receipt: the provenance footer carries
	 * source + freshness + row count and the "Show the math." peek. Right-click
	 * target for ask-about-this (§4.3).
	 */
	export interface Provenance {
		source: string;
		freshness: string;
		rows?: string | null;
	}
	interface Props {
		title: string;
		sub?: string | null;
		span?: number;
		/** Zero-based position when a composed panel list opts into the 24ms settle stagger. */
		settleIndex?: number | null;
		prov?: Provenance | null;
		children: Snippet;
		onaskabout?: () => void;
		onshowmath?: () => void;
	}
	let {
		title,
		sub = null,
		span = 4,
		settleIndex = null,
		prov = null,
		children,
		onaskabout,
		onshowmath,
	}: Props = $props();

	function contextMenu(e: MouseEvent) {
		if (!onaskabout) return;
		e.preventDefault();
		onaskabout();
	}

</script>

<article
	class="panel"
	style="grid-column: span {span}; --panel-settle-index: {Math.max(0, settleIndex ?? 0)}"
	oncontextmenu={contextMenu}
	role="group"
	aria-label={title}
>
	<h4>{title}</h4>
	{#if sub}<div class="sub">{sub}</div>{/if}
	<div class="body">{@render children()}</div>
	{#if prov}
		<div class="prov">
			<Icon name="receipt-text" size={12} />
			<span>{prov.source}{prov.rows ? ` · ${prov.rows}` : ""} · {prov.freshness}</span>
			{#if onaskabout}
				<button class="context" type="button" onclick={onaskabout} aria-label="Ask about {title}" title="Ask about this panel">
					<Icon name="mouse-pointer-2" size={12} />
				</button>
			{/if}
			{#if onshowmath || onaskabout}
				<button class="math" type="button" onclick={onshowmath ?? onaskabout}>Show the math.</button>
			{/if}
		</div>
	{/if}
</article>

<style>
	.panel {
		background: var(--s1);
		border-radius: var(--r-md);
		padding: var(--s-3) var(--s-3) var(--s-2);
		display: flex;
		flex-direction: column;
		min-width: 0;
		animation: settle var(--dur-mid) var(--ease-standard) both;
		animation-delay: calc(var(--panel-settle-index) * var(--dur-stagger));
	}
	h4 {
		font:
			500 0.84375rem var(--sans);
		margin-bottom: 2px;
	}
	.sub {
		font-size: 0.6875rem;
		color: var(--text-3);
		margin-bottom: var(--s-2);
	}
	.body {
		flex: 1;
		min-width: 0;
	}
	.prov {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		border-top: 1px solid var(--rule);
		margin-top: var(--s-2);
		padding-top: var(--s-2);
		font:
			400 0.6875rem var(--mono);
		color: var(--text-3);
	}
	.prov :global(svg) {
		flex: none;
	}
	.prov button {
		color: var(--petal-text);
		border: 0;
		background: transparent;
		padding: 0 var(--s-1);
		min-height: 32px;
		font-weight: 500;
	}
	.prov .context {
		width: 32px;
		padding: 0;
		margin-inline-start: auto;
		display: grid;
		place-items: center;
	}
	.prov button:focus-visible {
		outline: 2px solid var(--petal);
		outline-offset: 2px;
	}
	@keyframes settle {
		from {
			opacity: 0;
			transform: translateY(2px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.panel {
			animation: none;
		}
	}
</style>
