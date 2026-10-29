<script lang="ts">
	import { arcPath, clockwise, dayAngle, polar, romanHour, tangentRotation } from "$lib/dial";
	import type { LimitReading } from "$lib/limits";
	import type { Dossier } from "$lib/server/dossier";

	import DialFace from "./DialFace.svelte";
	import FiligreeHand from "./FiligreeHand.svelte";
	import LimitRing from "./LimitRing.svelte";

	let {
		sun,
		reading,
		now,
		label,
	}: { sun: Dossier["sun"]; reading: LimitReading; now: number; label: string } = $props();

	const SKY_RADIUS = 87;
	const SKY_WIDTH = 4;

	const hours = Array.from({ length: 24 }, (_, hour) => {
		// Hour 0 is midnight at the bottom of the dial; the ring reads XII, I ... XI twice.
		const degrees = (hour * 15 + 180) % 360;
		const at = polar(degrees, 99.6);

		return { hour, numeral: romanHour(hour), x: at.x, y: at.y, rotate: tangentRotation(degrees) };
	});
	const halfHours = Array.from({ length: 24 }, (_, hour) => polar((hour * 15 + 187.5) % 360, 99.6));

	const sky = $derived.by(() => {
		const arcOf = (from: number | null, to: number | null) =>
			from === null || to === null
				? null
				: { from: dayAngle(from), sweep: clockwise(dayAngle(from), dayAngle(to)) };

		return {
			twilight: arcOf(sun.dawnAt, sun.duskAt),
			daylight: arcOf(sun.sunriseAt, sun.sunsetAt),
			allDay: sun.sunriseAt === null && sun.altitudeDeg > 0,
		};
	});
	const sunMarks = $derived(
		[sun.sunriseAt, sun.sunsetAt].flatMap((at) => (at === null ? [] : [dayAngle(at)])),
	);
	const span = $derived(
		reading.startsAt === null || reading.resetsAt === null
			? null
			: {
					start: dayAngle(reading.startsAt),
					arc: clockwise(dayAngle(reading.startsAt), dayAngle(reading.resetsAt)),
				},
	);
	const clock = $derived.by(() => {
		const parts = new Intl.DateTimeFormat(undefined, {
			hour: "numeric",
			minute: "2-digit",
		}).formatToParts(now);

		return {
			time: parts
				.filter((part) => part.type !== "dayPeriod")
				.map((part) => part.value)
				.join("")
				.trim(),
			period: parts.find((part) => part.type === "dayPeriod")?.value ?? "",
		};
	});
</script>

<DialFace id="day" {label}>
	<g class="chapter">
		<circle class="chapter-band" r="100" stroke-width="15" />
		<circle class="engraved" r="107.6" />
		<circle class="engraved fine" r="106.4" />
		<circle class="engraved fine" r="93.6" />
		<circle class="engraved" r="92.4" />
		{#each hours as numeral (numeral.hour)}
			<text
				class="numeral"
				class:cardinal={numeral.hour % 6 === 0}
				transform="translate({numeral.x} {numeral.y}) rotate({numeral.rotate})"
			>
				{numeral.numeral}
			</text>
		{/each}
		{#each halfHours as dot, index (index)}
			<circle class="pip" cx={dot.x} cy={dot.y} r=".9" />
		{/each}
	</g>

	<g class="sky">
		<circle class="sky-night" r={SKY_RADIUS} stroke-width={SKY_WIDTH} />
		{#if sky.twilight}
			<path
				class="sky-twilight"
				d={arcPath(sky.twilight.from, sky.twilight.sweep, SKY_RADIUS)}
				stroke-width={SKY_WIDTH}
			/>
		{/if}
		{#if sky.daylight}
			<path
				class="sky-day"
				d={arcPath(sky.daylight.from, sky.daylight.sweep, SKY_RADIUS)}
				stroke-width={SKY_WIDTH}
			/>
		{:else if sky.allDay}
			<circle class="sky-day" r={SKY_RADIUS} stroke-width={SKY_WIDTH} />
		{/if}
		{#each sunMarks as mark (mark)}
			{@const a = polar(mark, SKY_RADIUS - SKY_WIDTH / 2 - 1)}
			{@const b = polar(mark, SKY_RADIUS + SKY_WIDTH / 2 + 1)}
			<line class="sky-mark" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
		{/each}
	</g>

	{#if span}
		<LimitRing
			{reading}
			radius={68}
			width={16}
			startDeg={span.start}
			arcDeg={span.arc}
			runsOutDeg={reading.runsOutAt === null ? null : dayAngle(reading.runsOutAt)}
			label="Claude · five hours"
		/>
	{:else}
		<text class="ring-empty" y="-62">Claude 5-hour: no window open</text>
	{/if}

	<FiligreeHand angle={dayAngle(now)} length={91} sunAt={SKY_RADIUS} />

	<circle class="boss" r="31" />
	<circle class="engraved" r="28.6" />
	<text class="boss-time" y="2">{clock.time}</text>
	<text class="boss-caption" y="14">{clock.period}</text>
</DialFace>
