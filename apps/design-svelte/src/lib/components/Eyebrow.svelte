<script lang="ts">
	import Icon from "./Icon.svelte";

	/** The section eyebrow: optional number, an accent icon, and a label. */
	let { no, icon, label }: { no?: string; icon: string; label: string } = $props();
</script>

<div class="eyebrow">
	{#if no}<span class="no">{no}</span>{/if}<span class="ico"><Icon name={icon} /></span>
	{label}
</div>
