<script lang="ts">
	import { formatDuration } from "$lib/format";
	import { limitWindowsFrom, readLimit } from "$lib/limits";
	import type { Dossier } from "$lib/server/dossier";
	import { solarCountdown } from "$lib/sky";
	import { onMount } from "svelte";

	import DayDial from "./DayDial.svelte";
	import LimitPlaque from "./LimitPlaque.svelte";
	import WeekDial from "./WeekDial.svelte";

	let { dossier }: { dossier: Dossier } = $props();

	// The server renders in UTC; every mark placed by local time waits for the browser clock.
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

	const readings = $derived.by(() => {
		if (now === null) {
			return null;
		}

		const [claude5h, claude7d, codex7d] = limitWindowsFrom(dossier.agents);

		return {
			claude5h: readLimit(claude5h, now),
			claude7d: readLimit(claude7d, now),
			codex7d: readLimit(codex7d, now),
		};
	});
	const codexCredits = $derived(
		dossier.agents.find((agent) => agent.kind === "codex")?.creditsBalance ?? null,
	);
	const time = (epoch: number) =>
		new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(epoch);
	const summary = (reading: NonNullable<typeof readings>["claude5h"]) =>
		reading.usedPct === null
			? `${reading.window.agent} ${reading.window.span}: no reading`
			: `${reading.window.agent} ${reading.window.span}: ${String(Math.round(reading.usedPct))}% used${
					reading.projectedPct === null
						? ""
						: `, on pace for ${String(Math.round(reading.projectedPct))}% at reset`
				}`;
	const sunLine = $derived.by(() => {
		if (now === null || dossier.sun.sunriseAt === null || dossier.sun.sunsetAt === null) {
			return null;
		}

		const next = solarCountdown(dossier.sun, now);

		return `Sunrise ${time(dossier.sun.sunriseAt)} · sunset ${time(dossier.sun.sunsetAt)}${
			next === null ? "" : ` · ${next.kind} in ${formatDuration(next.minutes * 60_000)}`
		}`;
	});
</script>

<section class="orloj" aria-label="Usage limits">
	<div class="orloj-dials">
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if readings && now !== null}
					<DayDial
						sun={dossier.sun}
						reading={readings.claude5h}
						{now}
						label="Day dial. {summary(readings.claude5h)}."
					/>
				{/if}
			</div>
			<figcaption>
				<strong>The day</strong>
				<span
					>Claude's 5-hour window on the 24-hour clock{#if sunLine}. {sunLine}{/if}</span
				>
			</figcaption>
		</figure>
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if readings && now !== null}
					<WeekDial
						rings={[
							{ reading: readings.claude7d, label: "Claude" },
							{ reading: readings.codex7d, label: "Codex" },
						]}
						{now}
						label="Week dial. {summary(readings.claude7d)}. {summary(readings.codex7d)}."
					/>
				{/if}
			</div>
			<figcaption>
				<strong>The week</strong>
				<span
					>The 7-day windows: Claude outside, Codex inside. Moon {dossier.moon.phaseName.toLowerCase()},
					{Math.round(dossier.moon.illumination * 100)}% lit</span
				>
			</figcaption>
		</figure>
	</div>

	<p class="orloj-key">
		The coloured fill is usage. The gilt line is time gone, the diamond is the reset, and the beads
		run to where the current pace lands at the reset.
	</p>

	<div class="orloj-plaques">
		{#if readings && now !== null}
			<LimitPlaque reading={readings.claude5h} {now} />
			<LimitPlaque reading={readings.claude7d} {now} />
			<LimitPlaque reading={readings.codex7d} {now} credits={codexCredits} />
		{/if}
	</div>
</section>
