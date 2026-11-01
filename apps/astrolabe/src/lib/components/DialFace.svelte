<script lang="ts">
	import { polar } from "$lib/dial";
	import type { Snippet } from "svelte";

	let {
		id,
		title,
		label,
		children,
	}: {
		id: string;
		/** One or two words, shown on hover. */
		title: string;
		label: string;
		children: Snippet;
	} = $props();

	const beads = Array.from({ length: 72 }, (_, index) => polar(index * 5, 114.2));
</script>

<!-- A group, not an image: the hand, the sky and each limit ring carry their own name and value. -->
<svg class="dial-face" viewBox="-120 -120 240 240" role="group" aria-label={label}>
	<title>{title}</title>
	<defs>
		<!-- One light, upper left, in dial coordinates: every face and both metals take it from here. -->
		<linearGradient
			id="{id}-brass"
			gradientUnits="userSpaceOnUse"
			x1="-118"
			y1="-118"
			x2="118"
			y2="118"
		>
			<stop offset="0" class="brass-hi" />
			<stop offset=".35" class="brass-lo" />
			<stop offset=".55" class="brass-hi" />
			<stop offset="1" class="brass-deep" />
		</linearGradient>
		<linearGradient
			id="{id}-paper"
			gradientUnits="userSpaceOnUse"
			x1="-110"
			y1="-110"
			x2="110"
			y2="110"
		>
			<stop offset="0" class="paper-mid" />
			<stop offset="1" class="paper-far" />
		</linearGradient>
		<filter id="{id}-grain" x="0" y="0" width="100%" height="100%">
			<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" />
			<feColorMatrix values="0 0 0 0 .32  0 0 0 0 .22  0 0 0 0 .1  0 0 0 .5 0" />
			<feComposite in2="SourceGraphic" operator="in" />
		</filter>
	</defs>

	<g aria-hidden="true">
		<circle class="bezel" r="118" fill="url(#{id}-brass)" />
		<circle class="bezel-rule" r="117.2" />
		{#each beads as bead, index (index)}
			<circle class="bead" cx={bead.x} cy={bead.y} r=".9" />
		{/each}
		<circle class="bezel-rule" r="111.2" />
		<circle class="paper" r="110.5" fill="url(#{id}-paper)" />
		<circle class="grain" r="110.5" filter="url(#{id}-grain)" />
	</g>

	{@render children()}
</svg>
