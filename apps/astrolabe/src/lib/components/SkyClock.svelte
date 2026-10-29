<script lang="ts">
	import type { Dossier } from "$lib/server/dossier";
	import SunIcon from "@lucide/svelte/icons/sun";
	import { onMount } from "svelte";

	let { sun, moon }: { sun: Dossier["sun"]; moon: Dossier["moon"] } = $props();

	// The dial draws in viewBox units centred on the origin. Noon sits at the top, midnight at the
	// bottom, and time runs clockwise, so the sun climbs the left side and sets down the right.
	const VIEW = { x: -156, y: -118, width: 312, height: 236 };
	const BAND_RADIUS = 92;
	const BAND_WIDTH = 18;
	const NUMERAL_RADIUS = 77;
	const LABEL_RADIUS = 114;
	const MINUTES_PER_DAY = 1_440;
	const SCRUB_STEP = 15;

	type Band = "daylight" | "twilight" | "night";

	const BAND_NAME: Record<Band, string> = {
		daylight: "Daylight",
		twilight: "Twilight",
		night: "Night",
	};

	// The server renders in UTC, so everything placed by local time waits for the browser clock.
	let now = $state<number | null>(null);
	// Minutes after local midnight the reader is pointing at, or null to follow the current time.
	let scrub = $state<number | null>(null);

	onMount(() => {
		now = Date.now();
		const interval = window.setInterval(() => {
			now = Date.now();
		}, 1_000);

		return () => {
			window.clearInterval(interval);
		};
	});

	const minuteOfDay = (epoch: number): number => {
		const date = new Date(epoch);

		return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
	};
	const point = (minute: number, radius: number) => {
		const angle = (minute / MINUTES_PER_DAY) * 2 * Math.PI;

		return { x: -radius * Math.sin(angle), y: radius * Math.cos(angle) };
	};
	const arc = (from: number, to: number, radius: number): string => {
		const start = point(from, radius);
		const end = point(to, radius);
		const span = (((to - from) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

		return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${String(radius)} ${String(radius)} 0 ${span > MINUTES_PER_DAY / 2 ? "1" : "0"} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
	};
	const within = (minute: number, from: number, to: number): boolean =>
		from <= to ? minute >= from && minute < to : minute >= from || minute < to;
	const percent = (value: number, origin: number, size: number): string =>
		`${(((value - origin) / size) * 100).toFixed(3)}%`;
	const timeLabel = (minute: number): string => {
		const date = new Date();
		date.setHours(0, Math.round(minute), 0, 0);

		return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
	};
	const timeParts = (minute: number): { clock: string; period: string } => {
		const date = new Date();
		date.setHours(0, Math.round(minute), 0, 0);
		const parts = new Intl.DateTimeFormat(undefined, {
			hour: "numeric",
			minute: "2-digit",
		}).formatToParts(date);

		return {
			clock: parts
				.filter((part) => part.type !== "dayPeriod")
				.map((part) => part.value)
				.join("")
				.trim(),
			period: parts.find((part) => part.type === "dayPeriod")?.value ?? "",
		};
	};
	const hourLabel = (hour: number): string => {
		if (hour === 0) return "Midnight";
		if (hour === 12) return "Noon";
		const date = new Date();
		date.setHours(hour, 0, 0, 0);

		return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(date);
	};
	const duration = (minutes: number): string => {
		const rounded = Math.round(Math.abs(minutes));
		const hours = Math.floor(rounded / 60);

		return hours === 0 ? `${String(rounded % 60)}m` : `${String(hours)}h ${String(rounded % 60)}m`;
	};

	const sky = $derived.by(() => {
		if (now === null) return null;

		const daylight =
			sun.sunriseAt !== null && sun.sunsetAt !== null
				? { from: minuteOfDay(sun.sunriseAt), to: minuteOfDay(sun.sunsetAt) }
				: null;
		const twilight =
			sun.dawnAt !== null && sun.duskAt !== null
				? { from: minuteOfDay(sun.dawnAt), to: minuteOfDay(sun.duskAt) }
				: null;
		const bandAt = (minute: number): Band => {
			if (daylight === null) return sun.altitudeDeg > 0 ? "daylight" : "night";
			if (within(minute, daylight.from, daylight.to)) return "daylight";
			if (twilight !== null && within(minute, twilight.from, twilight.to)) return "twilight";

			return "night";
		};

		return { now: minuteOfDay(now), daylight, twilight, bandAt };
	});

	const readout = $derived.by(() => {
		if (sky === null || now === null) return null;

		if (scrub !== null) {
			const ahead =
				((((scrub - sky.now) % MINUTES_PER_DAY) + MINUTES_PER_DAY * 1.5) % MINUTES_PER_DAY) -
				MINUTES_PER_DAY / 2;
			const band = sky.bandAt(scrub);

			return {
				minute: scrub,
				time: timeLabel(scrub),
				band,
				detail:
					Math.abs(ahead) < 1
						? "Now"
						: ahead > 0
							? `In ${duration(ahead)}`
							: `${duration(ahead)} ago`,
			};
		}

		const band = sky.bandAt(sky.now);
		const ahead = (minute: number) =>
			(((minute - sky.now) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
		const next =
			sky.daylight === null
				? null
				: [
						{ name: "Sunrise", in: ahead(sky.daylight.from) },
						{ name: "Sunset", in: ahead(sky.daylight.to) },
					].sort((a, b) => a.in - b.in)[0];
		const detail =
			next === undefined || next === null
				? "No sunrise or sunset today"
				: `${next.name} in ${duration(next.in)}`;

		return { minute: sky.now, time: timeLabel(sky.now), band, detail };
	});

	const pointer = $derived(scrub ?? sky?.now ?? 0);
	const markers = $derived(
		sky?.daylight
			? [
					{ name: "Sunrise", minute: sky.daylight.from },
					{ name: "Sunset", minute: sky.daylight.to },
				].map((marker) => {
					const at = point(marker.minute, LABEL_RADIUS);

					return {
						...marker,
						side: at.x < 0 ? "start" : "end",
						left: percent(at.x, VIEW.x, VIEW.width),
						top: percent(at.y, VIEW.y, VIEW.height),
					};
				})
			: [],
	);
	const dayLength = $derived(
		sun.sunriseAt !== null && sun.sunsetAt !== null && sun.sunsetAt > sun.sunriseAt
			? duration((sun.sunsetAt - sun.sunriseAt) / 60_000)
			: null,
	);
	const valueText = $derived(
		readout === null
			? "Loading the sky"
			: `${readout.time}, ${BAND_NAME[readout.band]}. ${readout.detail}`,
	);

	const minuteFromPointer = (event: PointerEvent): number => {
		const box = (event.currentTarget as Element).getBoundingClientRect();
		// Map the pointer into viewBox units so the angle is measured from the dial's true centre.
		const x = VIEW.x + ((event.clientX - box.left) / box.width) * VIEW.width;
		const y = VIEW.y + ((event.clientY - box.top) / box.height) * VIEW.height;
		const turn = Math.atan2(-x, y) / (2 * Math.PI);
		const minute = (((turn % 1) + 1) % 1) * MINUTES_PER_DAY;

		return (Math.round(minute / 5) * 5) % MINUTES_PER_DAY;
	};
	const onPointer = (event: PointerEvent) => {
		if (sky === null) return;
		if (event.pointerType !== "mouse" && event.buttons === 0 && event.type === "pointermove")
			return;
		scrub = minuteFromPointer(event);
	};
	const onKey = (event: KeyboardEvent) => {
		if (sky === null) return;
		const from = scrub ?? Math.round(sky.now / SCRUB_STEP) * SCRUB_STEP;
		const step = {
			ArrowRight: SCRUB_STEP,
			ArrowUp: SCRUB_STEP,
			ArrowLeft: -SCRUB_STEP,
			ArrowDown: -SCRUB_STEP,
			PageUp: 60,
			PageDown: -60,
		}[event.key];

		if (step !== undefined) {
			scrub = (((from + step) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
		} else if (event.key === "Home" || event.key === "Escape") {
			scrub = null;
		} else {
			return;
		}
		event.preventDefault();
	};
</script>

<section class="sky" aria-label="Sun and sky">
	<div
		class="dial"
		class:ready={sky !== null}
		class:scrubbing={scrub !== null}
		role="slider"
		tabindex="0"
		aria-label="24-hour sun clock"
		aria-valuemin={0}
		aria-valuemax={MINUTES_PER_DAY - 1}
		aria-valuenow={Math.round(pointer)}
		aria-valuetext={valueText}
		onpointerdown={onPointer}
		onpointermove={onPointer}
		onpointerleave={(event) => {
			if (event.pointerType === "mouse") scrub = null;
		}}
		onblur={() => (scrub = null)}
		onkeydown={onKey}
	>
		<svg viewBox="{VIEW.x} {VIEW.y} {VIEW.width} {VIEW.height}" aria-hidden="true">
			<circle class="focus-ring" r={BAND_RADIUS + BAND_WIDTH / 2 + 2.5} />
			<circle class="band night" r={BAND_RADIUS} stroke-width={BAND_WIDTH} />
			{#if sky}
				{#if sky.twilight}
					<path
						class="band twilight"
						d={arc(sky.twilight.from, sky.twilight.to, BAND_RADIUS)}
						stroke-width={BAND_WIDTH}
					/>
				{/if}
				{#if sky.daylight}
					<path
						class="band daylight"
						d={arc(sky.daylight.from, sky.daylight.to, BAND_RADIUS)}
						stroke-width={BAND_WIDTH}
					/>
				{:else if sky.bandAt(0) === "daylight"}
					<circle class="band daylight" r={BAND_RADIUS} stroke-width={BAND_WIDTH} />
				{/if}
			{/if}
			{#each { length: 24 }, hour (hour)}
				{@const inner = point(hour * 60, BAND_RADIUS - BAND_WIDTH / 2)}
				{@const outer = point(hour * 60, BAND_RADIUS + BAND_WIDTH / 2)}
				{@const tickEnd = point(hour * 60, BAND_RADIUS + BAND_WIDTH / 2 + (hour % 6 === 0 ? 9 : 5))}
				<line
					class="notch"
					class:major={hour % 6 === 0}
					x1={inner.x}
					y1={inner.y}
					x2={outer.x}
					y2={outer.y}
				/>
				<line
					class="tick"
					class:major={hour % 6 === 0}
					x1={outer.x + (tickEnd.x - outer.x) * 0.25}
					y1={outer.y + (tickEnd.y - outer.y) * 0.25}
					x2={tickEnd.x}
					y2={tickEnd.y}
				/>
			{/each}
			{#each [0, 3, 6, 9, 12, 15, 18, 21] as hour (hour)}
				{@const at = point(hour * 60, NUMERAL_RADIUS)}
				<text
					class="numeral"
					class:cardinal={hour % 6 === 0}
					x={at.x}
					y={at.y}
					text-anchor={Math.abs(at.x) < 1 ? "middle" : at.x < 0 ? "start" : "end"}
					dy={hour === 0 ? -3 : hour === 12 ? 3 : 0}>{hourLabel(hour)}</text
				>
			{/each}
			{#if sky}
				{#if scrub !== null}
					{@const ghost = point(scrub, BAND_RADIUS)}
					<circle class="ghost" cx={ghost.x} cy={ghost.y} r="10" />
				{/if}
				<g
					class="sun"
					style="transform: rotate({((sky.now / MINUTES_PER_DAY) * 360).toFixed(3)}deg)"
				>
					<circle class="sun-disc" cy={BAND_RADIUS} r="12.5" />
					<SunIcon x={-8.5} y={BAND_RADIUS - 8.5} size={17} strokeWidth={2.2} class="sun-glyph" />
				</g>
			{/if}
		</svg>

		{#each markers as marker (marker.name)}
			<p class="marker {marker.side}" style:left={marker.left} style:top={marker.top}>
				<span>{marker.name}</span>
				<strong class="mono">{timeLabel(marker.minute)}</strong>
			</p>
		{/each}

		<div class="readout" aria-hidden="true">
			{#if readout}
				{@const parts = timeParts(readout.minute)}
				<p class="readout-time mono">
					{parts.clock}{#if parts.period}<span class="readout-period">{parts.period}</span>{/if}
				</p>
				<p class="readout-band">
					<span class="swatch {readout.band}"></span>{BAND_NAME[readout.band]}
				</p>
				<p class="readout-detail">{readout.detail}</p>
			{/if}
		</div>
	</div>

	<p class="hint">
		<span class="hint-fine">Point at any hour to read the sky then.</span>
		<span class="hint-coarse">Touch any hour to read the sky then.</span>
	</p>

	<dl class="facts">
		<div>
			<dt>Day length</dt>
			<dd class="mono">{dayLength ?? "No sunset"}</dd>
		</div>
		<div>
			<dt>Solar noon</dt>
			<dd class="mono">
				{sky !== null && sun.solarNoonAt !== null ? timeLabel(minuteOfDay(sun.solarNoonAt)) : " "}
			</dd>
		</div>
		<div>
			<dt>Moon, <span class="mono">{Math.round(moon.illumination * 100)}%</span> lit</dt>
			<dd>{moon.phaseName}</dd>
		</div>
	</dl>
</section>

<style>
	.sky {
		margin-inline: auto;
		max-width: 42rem;
	}

	.dial {
		aspect-ratio: 312 / 236;
		container-type: inline-size;
		cursor: crosshair;
		outline: none;
		position: relative;
		touch-action: pan-y;
		user-select: none;
		-webkit-tap-highlight-color: transparent;
	}

	svg {
		display: block;
		height: 100%;
		overflow: visible;
		width: 100%;
	}

	.band {
		fill: none;
		transition:
			stroke var(--t),
			opacity var(--dur-slow) var(--ease-standard);
	}

	/* Night is the darkest band, daylight the brightest, so the dial reads like the sky it maps. */
	.band.night {
		stroke: color-mix(in srgb, var(--text) 82%, var(--bg));
	}
	.band.twilight {
		stroke: color-mix(in srgb, var(--petal) 30%, var(--text-soft));
	}
	.band.daylight {
		stroke: color-mix(in srgb, var(--petal) 34%, var(--bg));
	}

	:global([data-theme="dark"]) .band.night {
		stroke: var(--rule);
	}
	:global([data-theme="dark"]) .band.twilight {
		stroke: color-mix(in srgb, var(--petal) 45%, var(--rule));
	}
	:global([data-theme="dark"]) .band.daylight {
		stroke: color-mix(in srgb, var(--petal) 80%, var(--bg));
	}

	.dial:not(.ready) .band.night {
		opacity: 0.35;
	}

	.notch {
		stroke: var(--bg);
		stroke-width: 0.9;
		transition: stroke var(--t);
	}
	.notch.major {
		stroke-width: 2;
	}

	.tick {
		stroke: var(--text-soft);
		stroke-linecap: round;
		stroke-width: 1;
		transition: stroke var(--t);
	}
	.tick.major {
		stroke: var(--text-mute);
		stroke-width: 1.6;
	}

	.numeral {
		dominant-baseline: central;
		fill: var(--text-mute);
		font-family: var(--font-sans);
		font-size: 8.5px;
		transition: fill var(--t);
	}
	.numeral.cardinal {
		fill: var(--text);
		font-size: 9.5px;
		font-weight: 500;
	}

	.focus-ring {
		fill: none;
		opacity: 0;
		stroke: var(--petal);
		stroke-width: 2;
		transition: opacity var(--dur-fast) var(--ease-standard);
	}
	.dial:focus-visible .focus-ring {
		opacity: 1;
	}

	.sun {
		animation: rise 1.6s var(--ease-emph-in) both;
		transform-origin: 0 0;
	}
	.sun-disc {
		fill: var(--petal);
		stroke: var(--bg);
		stroke-width: 3;
		transition:
			fill var(--t),
			stroke var(--t);
	}
	.sun :global(.sun-glyph) {
		color: var(--on-petal);
	}

	.ghost {
		fill: none;
		stroke: var(--text);
		stroke-dasharray: 3 2.5;
		stroke-width: 1.5;
	}
	.scrubbing .sun {
		opacity: 0.55;
	}
	.sun {
		transition: opacity var(--dur-base) var(--ease-standard);
	}

	/* One authored moment: on load the sun sweeps round from midnight to now, showing the direction of travel. */
	@keyframes rise {
		from {
			transform: rotate(0deg);
		}
	}

	.marker {
		display: grid;
		line-height: 1.25;
		pointer-events: none;
		position: absolute;
		white-space: nowrap;
		animation: appear var(--dur-slow) var(--ease-standard) both;
	}
	.marker.start {
		text-align: end;
		transform: translate(-100%, -50%);
	}
	.marker.end {
		text-align: start;
		transform: translate(0, -50%);
	}
	.marker span {
		color: var(--text-mute);
		font-size: 0.75rem;
		transition: color var(--t);
	}
	.marker strong {
		color: var(--text);
		font-size: clamp(0.8125rem, 2.4cqi, 1rem);
		font-weight: 500;
		transition: color var(--t);
	}

	.readout {
		display: grid;
		inset: 0;
		justify-items: center;
		place-content: center;
		pointer-events: none;
		position: absolute;
		text-align: center;
	}
	.readout p {
		animation: appear var(--dur-slow) var(--ease-standard) both;
	}
	.readout-time {
		color: var(--text);
		font-size: clamp(1.75rem, 7.6cqi, 3rem);
		letter-spacing: 0;
		font-weight: 400;
		line-height: 1.05;
		transition: color var(--t);
	}
	.readout-period {
		font-size: 0.42em;
		margin-inline-start: 0.3em;
	}
	.readout-band {
		align-items: center;
		color: var(--text);
		display: inline-flex;
		font-size: clamp(0.8125rem, 2.6cqi, 1rem);
		font-weight: 500;
		gap: var(--s2);
		margin-top: var(--s2);
		transition: color var(--t);
	}
	.readout-detail {
		color: var(--text-mute);
		font-size: clamp(0.75rem, 2.2cqi, 0.875rem);
		transition: color var(--t);
	}

	.swatch {
		border-radius: 50%;
		display: inline-block;
		height: 0.625rem;
		width: 0.625rem;
	}
	.swatch.night {
		background: color-mix(in srgb, var(--text) 82%, var(--bg));
	}
	.swatch.twilight {
		background: color-mix(in srgb, var(--petal) 30%, var(--text-soft));
	}
	.swatch.daylight {
		background: color-mix(in srgb, var(--petal) 34%, var(--bg));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--petal) 55%, var(--bg));
	}
	:global([data-theme="dark"]) .swatch.night {
		background: var(--rule);
		box-shadow: 0 0 0 1px var(--rule-strong);
	}
	:global([data-theme="dark"]) .swatch.twilight {
		background: color-mix(in srgb, var(--petal) 45%, var(--rule));
	}
	:global([data-theme="dark"]) .swatch.daylight {
		background: color-mix(in srgb, var(--petal) 80%, var(--bg));
		box-shadow: none;
	}

	@keyframes appear {
		from {
			opacity: 0;
		}
	}

	.hint {
		color: var(--text-mute);
		font-size: 0.75rem;
		margin-top: var(--s2);
		text-align: center;
		transition: color var(--t);
	}
	.hint-coarse {
		display: none;
	}
	@media (hover: none) {
		.hint-fine {
			display: none;
		}
		.hint-coarse {
			display: inline;
		}
	}

	.facts {
		border-top: 1px solid var(--rule);
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		margin-top: var(--s4);
		padding-top: var(--s3);
		transition: border-color var(--t);
	}
	.facts > div {
		min-width: 0;
		padding-inline: var(--s3);
		text-align: center;
	}
	.facts > div + div {
		border-inline-start: 1px solid var(--rule);
		transition: border-color var(--t);
	}
	.facts dt {
		color: var(--text-mute);
		font-size: 0.75rem;
		transition: color var(--t);
	}
	.facts dd {
		color: var(--text);
		font-size: 0.875rem;
		font-weight: 500;
		min-height: 1.4em;
		transition: color var(--t);
	}

	@media (max-width: 600px) {
		.facts > div {
			padding-inline: var(--s2);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.sun,
		.marker,
		.readout p {
			animation: none;
		}
	}
</style>
