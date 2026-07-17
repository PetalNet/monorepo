<script lang="ts" generics="Name extends string">
	import { hasIcon, ICONS, type IconName } from "./icons";

	const warnedUnknownIcons = new Set<string>();

	interface Props {
		name: string extends Name ? Name : Name extends IconName ? Name : never;
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

	const Cmp = $derived(hasIcon(name) ? ICONS[name] : undefined);

	$effect(() => {
		if (import.meta.env.DEV && !Cmp && !warnedUnknownIcons.has(name)) {
			warnedUnknownIcons.add(name);
			console.warn(`[Icon] Unknown Lucide registry key: "${name}"`);
		}
	});
</script>

{#if Cmp}
	<Cmp {size} {color} {strokeWidth} aria-hidden={ariaHidden} {title} />
{/if}
