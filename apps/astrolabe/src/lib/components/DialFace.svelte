<script lang="ts">
	import { polar } from "$lib/dial";
	import type { Snippet } from "svelte";

	let { id, label, children }: { id: string; label: string; children: Snippet } = $props();

	const beads = Array.from({ length: 72 }, (_, index) => polar(index * 5, 114.2));
</script>

<svg class="dial-face" viewBox="-120 -120 240 240" role="img" aria-label={label}>
	<defs>
		<linearGradient id="{id}-brass" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" class="brass-hi" />
			<stop offset=".35" class="brass-lo" />
			<stop offset=".55" class="brass-hi" />
			<stop offset="1" class="brass-deep" />
		</linearGradient>
		<radialGradient id="{id}-paper" r=".5">
			<stop offset=".55" class="paper-mid" />
			<stop offset="1" class="paper-edge" />
		</radialGradient>
		<filter id="{id}-grain" x="0" y="0" width="100%" height="100%">
			<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" />
			<feColorMatrix values="0 0 0 0 .32  0 0 0 0 .22  0 0 0 0 .1  0 0 0 .5 0" />
			<feComposite in2="SourceGraphic" operator="in" />
		</filter>
	</defs>

	<circle class="bezel" r="118" fill="url(#{id}-brass)" />
	<circle class="bezel-rule" r="117.2" />
	{#each beads as bead, index (index)}
		<circle class="bead" cx={bead.x} cy={bead.y} r=".9" />
	{/each}
	<circle class="bezel-rule" r="111.2" />
	<circle class="paper" r="110.5" fill="url(#{id}-paper)" />
	<circle class="grain" r="110.5" filter="url(#{id}-grain)" />

	{@render children()}
</svg>
