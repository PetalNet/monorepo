<script lang="ts">
	let {
		angle,
		length,
		sunAt = null,
	}: { angle: number; length: number; sunAt?: number | null } = $props();

	// Drawn pointing at twelve o'clock, then turned. A tapered shaft, an open quatrefoil two thirds out,
	// a spade tip and a ringed counterweight, after the gilt hands of the Prague Orloj.
	const knot = $derived(length * 0.6);
	const rays = Array.from({ length: 8 }, (_, index) => index * 45);
</script>

<g class="hand" style:transform="rotate({angle}deg)">
	<path class="hand-shaft" d="M -1.6 14 L -0.55 {-length + 9} L 0.55 {-length + 9} L 1.6 14 Z" />
	<path
		class="hand-spade"
		d="M 0 {-length} C 3.4 {-length + 4} 4.2 {-length + 7} 0 {-length + 11} C -4.2 {-length +
			7} -3.4 {-length + 4} 0 {-length} Z"
	/>
	<g class="hand-knot">
		<circle cx="0" cy={-knot - 3.1} r="2.6" />
		<circle cx="0" cy={-knot + 3.1} r="2.6" />
		<circle cx="-3.1" cy={-knot} r="2.6" />
		<circle cx="3.1" cy={-knot} r="2.6" />
	</g>
	<circle class="hand-weight" cx="0" cy="20" r="5" />
	{#if sunAt !== null}
		<g class="hand-emblem" transform="translate(0 {-sunAt})">
			{#each rays as ray (ray)}
				<path d="M -1.3 -6 L 0 -9.2 L 1.3 -6 Z" transform="rotate({ray + 22.5})" />
			{/each}
			<circle r="5.4" />
		</g>
	{/if}
</g>
