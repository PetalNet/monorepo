<script lang="ts">
	import { ICONS } from "./icons";

	interface Props {
		name: string;
		size?: number;
		/** CSS color; defaults to currentColor via the icon's stroke. */
		color?: string;
		strokeWidth?: number;
		"aria-hidden"?: boolean;
		title?: string;
	}
	let {
		name,
		size = 16,
		color,
		strokeWidth = 2,
		"aria-hidden": ariaHidden = true,
		title,
	}: Props = $props();

	const Cmp = $derived(ICONS[name]);
</script>

{#if Cmp}
	<Cmp {size} {color} {strokeWidth} aria-hidden={ariaHidden} {title} />
{/if}
