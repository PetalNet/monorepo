<script lang="ts">
	import type { Dossier } from "$lib/server/dossier";
	import { onMount } from "svelte";

	let { sun }: { sun: Dossier["sun"] } = $props();

	// The server renders in UTC, so time-dependent marks wait for the browser's local clock.
	let now = $state<number | null>(null);

	onMount(() => {
		now = Date.now();

		const interval = window.setInterval(() => {
			now = Date.now();
		}, 1_000);

		return () => {
			window.clearInterval(interval);
		};
	});

	const fractionOfDay = (epoch: number): number => {
		const date = new Date(epoch);

		return (date.getHours() * 3_600 + date.getMinutes() * 60 + date.getSeconds()) / 86_400;
	};
	const point = (fraction: number, radius: number) => ({
		x: radius * Math.sin(fraction * 2 * Math.PI),
		y: -radius * Math.cos(fraction * 2 * Math.PI),
	});
	const arc = (from: number, to: number, radius: number): string => {
		const start = point(fractionOfDay(from), radius);
		const end = point(fractionOfDay(to), radius);
		const large = (fractionOfDay(to) - fractionOfDay(from) + 1) % 1 > 0.5 ? "1" : "0";

		return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${String(radius)} ${String(radius)} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
	};
	const timeOfDay = (epoch: number): string =>
		new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(epoch);

	const hands = $derived.by(() => {
		if (now === null) {
			return null;
		}

		const date = new Date(now);

		return {
			hour: point(fractionOfDay(now), 40),
			minute: point(date.getMinutes() / 60 + date.getSeconds() / 3_600, 31),
			second: point(date.getSeconds() / 60, 34),
		};
	});
	const daylight = $derived(
		sun.sunriseAt === null || sun.sunsetAt === null
			? ""
			: `, daylight ${timeOfDay(sun.sunriseAt)} to ${timeOfDay(sun.sunsetAt)}`,
	);
	const label = $derived(
		now === null ? "24-hour sky clock" : `24-hour sky clock, ${timeOfDay(now)}${daylight}`,
	);
</script>

<svg class="sky-clock" viewBox="-50 -50 100 100" role="img" aria-label={label}>
	<circle class="sky-clock-track" r="40" />
	{#each { length: 24 }, hour (hour)}
		{@const outer = point(hour / 24, 49)}
		{@const inner = point(hour / 24, hour % 6 === 0 ? 45 : 47)}
		<line
			class="sky-clock-tick"
			class:major={hour % 6 === 0}
			x1={outer.x}
			y1={outer.y}
			x2={inner.x}
			y2={inner.y}
		/>
	{/each}
	{#each [0, 6, 12, 18] as hour (hour)}
		{@const at = point(hour / 24, 27)}
		<text class="sky-clock-numeral mono" x={at.x} y={at.y}>{String(hour).padStart(2, "0")}</text>
	{/each}
	{#if hands}
		{#if sun.dawnAt !== null && sun.duskAt !== null}
			<path class="sky-clock-twilight" d={arc(sun.dawnAt, sun.duskAt, 40)} />
		{/if}
		{#if sun.sunriseAt !== null && sun.sunsetAt !== null}
			<path class="sky-clock-daylight" d={arc(sun.sunriseAt, sun.sunsetAt, 40)} />
		{/if}
		<line class="sky-clock-hand minute" x2={hands.minute.x} y2={hands.minute.y} />
		<line class="sky-clock-hand hour" x2={hands.hour.x * 0.9} y2={hands.hour.y * 0.9} />
		<line class="sky-clock-hand second" x2={hands.second.x} y2={hands.second.y} />
		<circle class="sky-clock-sun" cx={hands.hour.x} cy={hands.hour.y} r="4" />
		<circle class="sky-clock-cap" r="2" />
	{/if}
</svg>
