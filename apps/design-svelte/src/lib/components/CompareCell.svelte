<script lang="ts">
	import type { Snippet } from "svelte";

	import Icon from "./Icon.svelte";

	/**
	 * A do/don't comparison cell. kind "bad" shows a Don't tag (x icon),
	 * "good" shows a Do tag (check icon). The body is a snippet so each cell
	 * can carry arbitrary content (text, palettes, dots, marks).
	 */
	let { kind, children }: { kind: "bad" | "good"; children: Snippet } = $props();
</script>

<div class="compare-cell {kind}">
	{#if kind === "bad"}
		<span class="compare-tag dont"><span><Icon name="x" /></span>Don't</span>
	{:else}
		<span class="compare-tag do"><span><Icon name="check" /></span>Do</span>
	{/if}
	{@render children()}
</div>
