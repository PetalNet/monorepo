<script lang="ts">
	import { limitWindowsFrom, readLimit } from "$lib/limits";
	import type { Dossier } from "$lib/server/dossier";
	import { sunCaption } from "$lib/sky";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
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

	const plan = $derived(limitWindowsFrom(dossier.agents));
	const readings = $derived.by(() => {
		const at = now;

		return at === null ? null : plan.windows.map((window) => readLimit(window, at));
	});
	// The dials draw the plan's windows; one the plan doesn't list gets a flagged plaque only.
	const rings = (span: "5-hour" | "7-day") =>
		(readings ?? []).filter(
			(reading) => reading.window.span === span && reading.window.fit !== "unlisted",
		);
	const time = (epoch: number) =>
		new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(epoch);
	const sunLine = $derived(now === null ? null : sunCaption(dossier.sun, now, time));
</script>

<section class="orloj" aria-label="Usage limits">
	<div class="orloj-dials">
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if readings && now !== null}
					<DayDial sun={dossier.sun} rings={rings("5-hour")} {now} />
				{/if}
			</div>
			{#if sunLine}<figcaption>{sunLine}</figcaption>{/if}
		</figure>
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if readings && now !== null}
					<WeekDial rings={rings("7-day")} {now} />
				{/if}
			</div>
			<figcaption>
				{dossier.moon.phaseName}, {Math.round(dossier.moon.illumination * 100)}% lit.
			</figcaption>
		</figure>
	</div>

	<div class="orloj-plaques">
		{#if readings && now !== null}
			{#each readings as reading (reading.window.id)}
				<LimitPlaque {reading} {now} />
			{/each}
		{/if}
	</div>
	{#if plan.notices.length > 0}
		<ul class="plan-notices">
			{#each plan.notices as notice (notice)}
				<li><TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />{notice}</li>
			{/each}
		</ul>
	{/if}
</section>
