<script lang="ts">
	import { arcPath, polar, tangentRotation, usageLabelAt, type WindowGeometry } from "$lib/dial";
	import type { LimitReading } from "$lib/limits";

	let {
		reading,
		geometry,
		radius,
		width,
		hand,
	}: {
		reading: LimitReading;
		/** Every point of the window as a local clock angle, from `windowGeometry`. */
		geometry: WindowGeometry;
		radius: number;
		width: number;
		/** Angle of the dial's hand, which the usage figure keeps clear of. */
		hand: number;
	} = $props();

	const outer = $derived(radius + width / 2);
	const inner = $derived(radius - width / 2);
	const startDeg = $derived(geometry.start);
	const arcDeg = $derived(geometry.reset);
	const fillSweep = $derived(geometry.fill);
	const runsOutDeg = $derived(geometry.runsOut);
	// The usage figure sits at the end of the fill. The projection is the plaque's job.
	const usage = $derived.by(() => {
		if (reading.usedPct === null) {
			return null;
		}

		const text = `${String(Math.round(reading.usedPct))}%`;
		const spot = usageLabelAt({
			start: startDeg,
			fill: fillSweep,
			reset: arcDeg,
			hand,
			halfDeg: ((text.length * 2.2 + 1.5) / radius) * (180 / Math.PI),
			radius,
		});

		if (spot === null) {
			return null;
		}

		const at = polar(spot.angle, radius);

		return { text, inside: spot.inside, x: at.x, y: at.y, rotate: tangentRotation(spot.angle) };
	});
	const alarm = $derived(reading.state === "overshoot" || reading.state === "limit-reached");
	const resetDeg = $derived(startDeg + arcDeg);
	const lozenge = (degrees: number, at: number, size: number) => {
		const tip = polar(degrees, at + size);
		const left = polar(degrees - (size * 40) / at, at);
		const base = polar(degrees, at - size);
		const right = polar(degrees + (size * 40) / at, at);

		const points = [tip, left, base, right].map(
			(point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
		);

		return `M ${points.join(" L ")} Z`;
	};
	const across = (degrees: number, from: number, to: number) => {
		const a = polar(degrees, from);
		const b = polar(degrees, to);

		return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
	};
</script>

<g class="limit {reading.window.id}" class:alarm>
	<path class="groove" d={arcPath(startDeg, geometry.groove, radius)} stroke-width={width} />
	{#if fillSweep > 0}
		<path class="fill" d={arcPath(startDeg, fillSweep, radius)} stroke-width={width - 3} />
	{/if}
	{#if usage}
		<text
			class="usage"
			class:inside={usage.inside}
			transform="translate({usage.x} {usage.y}) rotate({usage.rotate})"
		>
			{usage.text}
		</text>
	{/if}
	{#if alarm}
		<path class="alarm-rule" d={arcPath(startDeg, geometry.groove, outer + 0.6)} />
		<path class="alarm-rule" d={arcPath(startDeg, geometry.groove, inner - 0.6)} />
	{/if}

	<line class="reset-rule" {...across(resetDeg, inner - 1.5, outer + 6)} />
	<path class="reset-mark" d={lozenge(resetDeg, outer + 6.5, 3.4)} />

	{#if runsOutDeg !== null}
		<line class="runs-out" {...across(runsOutDeg, inner - 3, outer + 3)} />
	{/if}
</g>
