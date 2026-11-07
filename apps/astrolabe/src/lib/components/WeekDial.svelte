<script lang="ts">
	import {
		ASCENDER_HEIGHT,
		BOSS_RADIUS,
		CAP_HEIGHT,
		polar,
		readingArc,
		stackBaselines,
		weekAngle,
		WEEK_RINGS,
		WEEK_SCALE,
		windowGeometry,
	} from "$lib/dial";
	import type { LimitReading } from "$lib/limits";

	import DialFace from "./DialFace.svelte";
	import FiligreeHand from "./FiligreeHand.svelte";
	import LimitRing from "./LimitRing.svelte";

	let {
		rings,
		now,
	}: {
		/** Claude outside, Codex inside. */
		rings: [LimitReading, LimitReading];
		now: number;
	} = $props();

	const DAY_DEG = 360 / 7;
	const placed = $derived(
		[
			{ reading: rings[0], radius: WEEK_RINGS.radii[0] },
			{ reading: rings[1], radius: WEEK_RINGS.radii[1] },
		].map((ring) => ({ ...ring, geometry: windowGeometry(ring.reading, WEEK_SCALE) })),
	);

	const days = $derived.by(() => {
		// 2024-01-01 was a Monday; any Monday-to-Sunday run gives the locale's weekday names in order.
		const format = new Intl.DateTimeFormat(undefined, { weekday: "long" });

		return Array.from({ length: 7 }, (_, index) => {
			return {
				name: format.format(new Date(2024, 0, 1 + index)),
				arc: readingArc((index + 0.5) * DAY_DEG, DAY_DEG - 2, 100),
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
	// Every weekday name has a d, so its ink rises to the ascenders; the date is capitals and figures.
	const BOSS = { day: 10.5, caption: 7.4 };
	const baselines = stackBaselines(
		{ size: BOSS.day, rise: ASCENDER_HEIGHT },
		{ size: BOSS.caption, rise: CAP_HEIGHT },
		4.6,
	);
</script>

<DialFace id="week" title="Week" label="Week dial">
	<g class="chapter" aria-hidden="true">
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
			<path id="weekday-{index}" class="lane" d={day.arc} />
			<text class="weekday" class:today={index === today}>
				<textPath href="#weekday-{index}" startOffset="50%">{day.name}</textPath>
			</text>
		{/each}
	</g>

	{#each placed as ring (ring.reading.window.id)}
		{#if ring.geometry}
			<LimitRing
				reading={ring.reading}
				radius={ring.radius}
				width={WEEK_RINGS.width}
				geometry={ring.geometry}
				hand={weekAngle(now)}
			/>
		{:else}
			<circle
				class="groove empty"
				r={ring.radius}
				stroke-width={WEEK_RINGS.width}
				role="img"
				aria-label="{ring.reading.window.agent} {ring.reading.window.span}: no reading"
			/>
		{/if}
	{/each}

	<FiligreeHand angle={weekAngle(now)} length={91} label="Now: {date.weekday}" />

	<circle class="boss" r={BOSS_RADIUS} />
	<circle class="engraved" r="28.6" />
	<text class="boss-day" y={baselines.line} font-size={BOSS.day}>{date.weekday}</text>
	<text class="boss-caption" y={baselines.caption} font-size={BOSS.caption}>{date.day}</text>
</DialFace>
