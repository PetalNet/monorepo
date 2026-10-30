<script lang="ts">
	import { limitWindowsFrom, readLimit } from "$lib/limits";
	import type { Dossier } from "$lib/server/dossier";
	import { sunCaption } from "$lib/sky";
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
	const sunLine = $derived(now === null ? null : sunCaption(dossier.sun, now, time));
</script>

<section class="orloj" aria-label="Usage limits">
	<div class="orloj-dials">
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if readings && now !== null}
					<DayDial sun={dossier.sun} reading={readings.claude5h} {now} />
				{/if}
			</div>
			{#if sunLine}<figcaption>{sunLine}</figcaption>{/if}
		</figure>
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if readings && now !== null}
					<WeekDial rings={[readings.claude7d, readings.codex7d]} {now} />
				{/if}
			</div>
			<figcaption>
				{dossier.moon.phaseName}, {Math.round(dossier.moon.illumination * 100)}% lit.
			</figcaption>
		</figure>
	</div>

	<div class="orloj-plaques">
		{#if readings && now !== null}
			<LimitPlaque reading={readings.claude5h} {now} />
			<LimitPlaque reading={readings.claude7d} {now} />
			<LimitPlaque reading={readings.codex7d} {now} credits={codexCredits} />
		{/if}
	</div>
</section>
