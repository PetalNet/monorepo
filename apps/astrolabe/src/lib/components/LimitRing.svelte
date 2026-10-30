<script lang="ts">
	import {
		arcPath,
		clockwise,
		polar,
		tangentRotation,
		usageLabelAt,
		type WindowGeometry,
	} from "$lib/dial";
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
	const resetDeg = $derived(startDeg + arcDeg);
	// Red marks only the stretch the limit is projected to be spent, up to the reset: from the
	// runs-out point, or from now once the limit is reached.
	const lockoutFrom = $derived(
		reading.state === "limit-reached" ? hand : reading.state === "overshoot" ? runsOutDeg : null,
	);
	const lockout = $derived(
		lockoutFrom === null ? null : { from: lockoutFrom, sweep: clockwise(lockoutFrom, resetDeg) },
	);
	const name = $derived(
		`${reading.window.agent} ${reading.window.span === "5-hour" ? "5h" : "7d"}`,
	);
	const at = (epoch: number) =>
		new Intl.DateTimeFormat(
			undefined,
			reading.window.span === "5-hour"
				? { hour: "numeric", minute: "2-digit" }
				: { weekday: "short", hour: "numeric", minute: "2-digit" },
		).format(epoch);
	const spoken = $derived(
		[
			`${reading.window.agent} ${reading.window.span}: ${String(Math.round(reading.usedPct ?? 0))}% used`,
			reading.runsOutAt === null ? null : `runs out ${at(reading.runsOutAt)}`,
			reading.resetsAt === null ? null : `resets ${at(reading.resetsAt)}`,
		]
			.filter((part) => part !== null)
			.join(", "),
	);
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

<g class="limit {reading.window.id}" role="img" aria-label={spoken}>
	<title>{name}</title>
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
	{#if lockout && lockout.sweep > 0}
		<g class="lockout">
			<title>{reading.state === "limit-reached" ? "Limit reached" : "Runs out"}</title>
			<path d={arcPath(lockout.from, lockout.sweep, outer + 0.6)} />
			<path d={arcPath(lockout.from, lockout.sweep, inner - 0.6)} />
			<line {...across(lockout.from, inner - 0.6, outer + 0.6)} />
		</g>
	{/if}

	<g class="reset">
		<title>Reset</title>
		<line class="reset-rule" {...across(resetDeg, inner - 1.5, outer + 6)} />
		<path class="reset-mark" d={lozenge(resetDeg, outer + 6.5, 3.4)} />
	</g>
</g>
