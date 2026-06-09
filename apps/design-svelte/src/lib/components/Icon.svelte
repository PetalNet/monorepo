<script lang="ts">
	import { ICONS } from "../icons";

	/**
	 * A lucide icon, drawn from the inlined path map. Renders the same
	 * <svg viewBox="0 0 24 24" stroke-width="2" ...> wrapper the source page uses,
	 * so the glyph is present at first paint (SSR) — no layout shift, works with
	 * JS disabled.
	 */
	let { name }: { name: keyof typeof ICONS | string } = $props();
	const inner = $derived(ICONS[name] ?? "");
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true">
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html inner}
</svg>
