<script lang="ts">
	import {
		arcPath,
		BOSS_RADIUS,
		CAP_HEIGHT,
		clockwise,
		dayAngle,
		polar,
		ringLayout,
		romanHour,
		stackBaselines,
		tangentRotation,
		DAY_SCALE,
		windowGeometry,
	} from "$lib/dial";
	import type { LimitReading } from "$lib/limits";
	import type { Dossier } from "$lib/server/dossier";

	import DialFace from "./DialFace.svelte";
	import FiligreeHand from "./FiligreeHand.svelte";
	import LimitRing from "./LimitRing.svelte";

	let { sun, rings, now }: { sun: Dossier["sun"]; rings: LimitReading[]; now: number } = $props();

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
	const clockTime = (epoch: number) =>
		new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(epoch);
	const sunMarks = $derived(
		(
			[
				["Sunrise", sun.sunriseAt],
				["Sunset", sun.sunsetAt],
			] as const
		).flatMap(([name, at]) => (at === null ? [] : [{ name, at, angle: dayAngle(at) }])),
	);
	const skyLabel = $derived(
		sunMarks.length === 0
			? sky.allDay
				? "Daylight: sun up all day"
				: "Daylight: sun down all day"
			: `Daylight: ${sunMarks.map((mark) => `${mark.name.toLowerCase()} ${clockTime(mark.at)}`).join(", ")}`,
	);
	const layout = $derived(ringLayout("day", rings.length));
	const placed = $derived(
		rings.slice(0, layout.radii.length).map((reading, index) => ({
			reading,
			radius: layout.radii[index],
			geometry: windowGeometry(reading, DAY_SCALE),
		})),
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
	// The time is figures and the day period capitals, so both lines rise to the cap height. A 24-hour
	// locale has no period, and the time alone is centred.
	const BOSS = { time: 15, caption: 7.4 };
	const baselines = $derived(
		stackBaselines(
			{ size: BOSS.time, rise: CAP_HEIGHT },
			clock.period ? { size: BOSS.caption, rise: CAP_HEIGHT } : null,
			4.6,
		),
	);
</script>

<DialFace id="day" title="Day" label="Day dial">
	<g class="chapter" aria-hidden="true">
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

	<g class="sky" role="img" aria-label={skyLabel}>
		<title>Daylight</title>
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
		{#each sunMarks as mark (mark.name)}
			{@const a = polar(mark.angle, SKY_RADIUS - SKY_WIDTH / 2 - 1)}
			{@const b = polar(mark.angle, SKY_RADIUS + SKY_WIDTH / 2 + 1)}
			<line class="sky-mark" x1={a.x} y1={a.y} x2={b.x} y2={b.y}><title>{mark.name}</title></line>
		{/each}
	</g>

	{#each placed as ring (ring.reading.window.id)}
		{#if ring.geometry}
			<LimitRing
				reading={ring.reading}
				radius={ring.radius}
				width={layout.width}
				geometry={ring.geometry}
				hand={dayAngle(now)}
			/>
		{:else}
			<circle
				class="groove empty"
				r={ring.radius}
				stroke-width={layout.width}
				role="img"
				aria-label="{ring.reading.window.agent} {ring.reading.window.span}: no reading"
			/>
		{/if}
	{:else}
		<text class="ring-empty" y="-62">No 5-hour limit on these plans</text>
	{/each}

	<FiligreeHand
		angle={dayAngle(now)}
		length={91}
		label="Now: {clockTime(now)}"
		sunAt={SKY_RADIUS}
	/>

	<circle class="boss" r={BOSS_RADIUS} />
	<circle class="engraved" r="28.6" />
	<text class="boss-time" y={baselines.line} font-size={BOSS.time}>{clock.time}</text>
	{#if clock.period}
		<text class="boss-caption" y={baselines.caption} font-size={BOSS.caption}>{clock.period}</text>
	{/if}
</DialFace>
