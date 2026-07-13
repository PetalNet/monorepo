<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HealthVerdict } from "$lib/api/derive";
	import type { Me } from "$lib/api/types";
	import Sidebar from "./Sidebar.svelte";
	import Snackbar from "./Snackbar.svelte";

	/**
	 * The one fixed frame, three regions (foundations §2.1): sidebar 232px + canvas.
	 * Collapses to a 56px icon rail below 1280px; single-column canvas below 1024px.
	 * The dock + snackbars share the bottom edge (the dock is owned by the surface).
	 */
	interface Props {
		me: Me;
		verdict: HealthVerdict;
		stateFact?: string | null;
		badges?: Record<string, number | "down" | "p0" | "warn" | "muted" | null>;
		children: Snippet;
	}
	let { me, verdict, stateFact = null, badges = {}, children }: Props = $props();
</script>

<div class="shell">
	<Sidebar {me} {verdict} {stateFact} {badges} />
	<main class="canvas">{@render children()}</main>
</div>
<Snackbar />

<style>
	.shell {
		display: grid;
		grid-template-columns: 232px 1fr;
		min-height: 100dvh;
		background: var(--bg);
	}
	.canvas {
		padding: var(--s-4) var(--s-4) var(--s-5);
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	@media (max-width: 1279px) {
		.shell {
			grid-template-columns: 56px 1fr;
		}
	}
	@media (max-width: 767px) {
		.canvas {
			padding: var(--s-3) var(--s-3) var(--s-5);
		}
	}
</style>
