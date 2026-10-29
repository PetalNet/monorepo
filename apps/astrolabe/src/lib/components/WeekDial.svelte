<script lang="ts">
	import { polar, tangentRotation, weekAngle, WEEK_SCALE, windowGeometry } from "$lib/dial";
	import type { LimitReading } from "$lib/limits";

	import DialFace from "./DialFace.svelte";
	import FiligreeHand from "./FiligreeHand.svelte";
	import LimitRing from "./LimitRing.svelte";

	let {
		rings,
		now,
		label,
	}: { rings: { reading: LimitReading; label: string }[]; now: number; label: string } = $props();

	const DAY_DEG = 360 / 7;
	const RADII = [79, 55];

	const days = $derived.by(() => {
		// 2024-01-01 was a Monday; any Monday-to-Sunday run gives the locale's weekday names in order.
		const format = new Intl.DateTimeFormat(undefined, { weekday: "long" });

		return Array.from({ length: 7 }, (_, index) => {
			const degrees = (index + 0.5) * DAY_DEG;
			const at = polar(degrees, 99.6);

			return {
				name: format.format(new Date(2024, 0, 1 + index)),
				x: at.x,
				y: at.y,
				rotate: tangentRotation(degrees),
			};
		});
	});
	const dividers = Array.from({ length: 7 }, (_, index) => {
		const a = polar(index * DAY_DEG, 92.4);
		const b = polar(index * DAY_DEG, 107.6);

		return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
	});
	const quarters = Array.from({ length: 28 }, (_, index) => index)
		.filter((index) => index % 4 !== 0)
		.map((index) => {
			const a = polar(index * (DAY_DEG / 4), 92.4);
			const b = polar(index * (DAY_DEG / 4), 94.6);

			return { index, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
		});
	const today = $derived(Math.floor(weekAngle(now) / DAY_DEG));
	const date = $derived({
		weekday: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(now),
		day: new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" }).format(now),
	});
</script>

<DialFace id="week" {label}>
	<g class="chapter">
		<circle class="chapter-band" r="100" stroke-width="15" />
		<circle class="engraved" r="107.6" />
		<circle class="engraved fine" r="106.4" />
		<circle class="engraved fine" r="93.6" />
		<circle class="engraved" r="92.4" />
		{#each dividers as line, index (index)}
			<line class="engraved" {...line} />
		{/each}
		{#each quarters as tick (tick.index)}
			<line class="engraved fine" x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} />
		{/each}
		{#each days as day, index (day.name)}
			<text
				class="weekday"
				class:today={index === today}
				transform="translate({day.x} {day.y}) rotate({day.rotate})"
			>
				{day.name}
			</text>
		{/each}
	</g>

	{#each rings as ring, index (ring.reading.window.id)}
		{@const radius = RADII[index] ?? 40}
		{@const geometry = windowGeometry(ring.reading, now, WEEK_SCALE)}
		{#if geometry}
			<LimitRing reading={ring.reading} {radius} width={15} {geometry} label={ring.label} />
		{:else}
			<circle class="groove empty" r={radius} stroke-width="15" />
		{/if}
	{/each}

	<FiligreeHand angle={weekAngle(now)} length={91} />

	<circle class="boss" r="31" />
	<circle class="engraved" r="28.6" />
	<text class="boss-day" y="-1">{date.weekday}</text>
	<text class="boss-caption" y="11">{date.day}</text>
</DialFace>
