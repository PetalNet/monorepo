<script lang="ts">
	import { arcPath, polar, tangentRotation, type WindowGeometry } from "$lib/dial";
	import type { LimitReading } from "$lib/limits";

	let {
		reading,
		geometry,
		radius,
		width,
		label,
	}: {
		reading: LimitReading;
		/** Every point of the window as a local clock angle, from `windowGeometry`. */
		geometry: WindowGeometry;
		radius: number;
		width: number;
		label: string;
	} = $props();

	const outer = $derived(radius + width / 2);
	const inner = $derived(radius - width / 2);
	const startDeg = $derived(geometry.start);
	const arcDeg = $derived(geometry.reset);
	const fillSweep = $derived(geometry.fill);
	const projectedSweep = $derived(geometry.projection);
	const elapsedSweep = $derived(geometry.elapsed);
	const runsOutDeg = $derived(geometry.runsOut);
	// Degrees the landing label needs on this ring to clear the reset diamond: about 9 units of arc.
	const labelClearance = $derived((9 / radius) * (180 / Math.PI) + 3);
	const landing = $derived.by(() => {
		if (
			reading.projectedPct === null ||
			projectedSweep === null ||
			reading.state === "limit-reached"
		)
			return null;
		// An overshoot lands on the reset, so step back along the ring until the label clears the diamond.
		const along = Math.min(projectedSweep, arcDeg - labelClearance);
		const at = polar(startDeg + along, radius);

		return {
			text: `${String(Math.round(reading.projectedPct))}%`,
			x: at.x,
			y: at.y,
			rotate: tangentRotation(startDeg + along),
		};
	});
	// The engraved name starts at the window's start, which on a full-turn ring is also the reset.
	// Slide it along when the projection's landing label would sit on top of it.
	const labelOffset = $derived(
		projectedSweep !== null && (projectedSweep < 30 || projectedSweep > arcDeg - 18) ? 16 : 1.5,
	);
	const alarm = $derived(reading.state === "overshoot" || reading.state === "limit-reached");
	const resetDeg = $derived(startDeg + arcDeg);
	const lozenge = (degrees: number, at: number, size: number) => {
		const tip = polar(degrees, at + size);
		const left = polar(degrees - (size * 40) / at, at);
		const base = polar(degrees, at - size);
		const right = polar(degrees + (size * 40) / at, at);

		return `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${base.x} ${base.y} L ${right.x} ${right.y} Z`;
	};
	const across = (degrees: number, from: number, to: number) => {
		const a = polar(degrees, from);
		const b = polar(degrees, to);

		return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
	};
</script>

<g class="limit {reading.window.id}" class:alarm>
	<path
		id="lane-{reading.window.id}"
		class="lane"
		d={arcPath(startDeg + labelOffset, Math.max(arcDeg - labelOffset - 1.5, 0), inner - 4.2)}
	/>
	<text class="ring-label"><textPath href="#lane-{reading.window.id}">{label}</textPath></text>

	<path class="groove" d={arcPath(startDeg, arcDeg, radius)} stroke-width={width} />
	{#if fillSweep > 0}
		<path class="fill" d={arcPath(startDeg, fillSweep, radius)} stroke-width={width - 3} />
	{/if}
	{#if projectedSweep !== null && projectedSweep > fillSweep}
		<path
			class="projection"
			d={arcPath(startDeg + fillSweep, projectedSweep - fillSweep, radius)}
		/>
	{/if}
	{#if landing}
		<text
			class="landing"
			class:over={reading.state === "overshoot"}
			transform="translate({landing.x} {landing.y}) rotate({landing.rotate})"
		>
			{landing.text}
		</text>
	{/if}
	{#if alarm}
		<path class="alarm-rule" d={arcPath(startDeg, arcDeg, outer + 0.6)} />
		<path class="alarm-rule" d={arcPath(startDeg, arcDeg, inner - 0.6)} />
	{/if}

	{#if elapsedSweep > 0}
		<path class="elapsed" d={arcPath(startDeg, elapsedSweep, outer + 3.2)} />
		<path class="elapsed-tip" d={lozenge(startDeg + elapsedSweep, outer + 3.2, 2.4)} />
	{/if}

	<line class="reset-rule" {...across(resetDeg, inner - 1.5, outer + 6)} />
	<path class="reset-mark" d={lozenge(resetDeg, outer + 6.5, 3.4)} />

	{#if runsOutDeg !== null}
		<line class="runs-out" {...across(runsOutDeg, inner - 3, outer + 3)} />
	{/if}
</g>
