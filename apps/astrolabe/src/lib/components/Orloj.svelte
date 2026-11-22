<script lang="ts">
	import { onMount } from "svelte";

	import { ringCapacity } from "#lib/dial.ts";
	import { limitsFrom, readLimit, type LimitReading } from "#lib/limits.ts";
	import type { Dossier, UsageReadout, WindowSpan } from "#lib/server/dossier.ts";
	import { sunCaption } from "#lib/sky.ts";

	import DayDial from "./DayDial.svelte";
	import ProviderPlate from "./ProviderPlate.svelte";
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

	interface Plate {
		provider: UsageReadout;
		notes: string[];
		readings: LimitReading[];
		/** The plate's place among the providers. */
		order: number;
	}

	const providers = $derived.by(() => {
		const at = now;

		return at === null
			? null
			: dossier.providers.map((provider) => {
					const { windows, notes } = limitsFrom(provider, at);

					return { provider, notes, readings: windows.map((window) => readLimit(window, at)) };
				});
	});
	// Plates hang in two columns: Claude and Codex at their heads, cut to one height, then each
	// provider under the column with fewer rows hanging so far, so one with many limits leaves no
	// hole beside it.
	const columns = $derived.by(() => {
		const columns: { rows: number; head: Plate; rest: Plate[] }[] = [];

		for (const [order, provider] of (providers ?? []).entries()) {
			const plate = { ...provider, order };

			if (columns.length < 2) {
				columns.push({ rows: 0, head: plate, rest: [] });

				continue;
			}

			const column = columns[0].rows <= columns[1].rows ? columns[0] : columns[1];

			column.rows += 1 + provider.readings.length;
			column.rest.push(plate);
		}

		return columns;
	});
	// Each dial draws the limits of its span in plate order, as far as it has rings.
	const rings = (span: WindowSpan) =>
		(providers ?? [])
			.flatMap((provider) => provider.readings)
			.filter((reading) => reading.window.span === span)
			.slice(0, ringCapacity(span === "5-hour" ? "day" : "week"));
	const drawn = $derived(
		new Set([...rings("5-hour"), ...rings("7-day")].map((reading) => reading.window.id)),
	);
	const time = (epoch: number) =>
		new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(epoch);
	const sunLine = $derived(now === null ? null : sunCaption(dossier.sun, now, time));
</script>

<section class="orloj" aria-label="Usage limits">
	<div class="orloj-dials">
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if providers && now !== null}
					<DayDial sun={dossier.sun} rings={rings("5-hour")} {now} />
				{/if}
			</div>
			{#if sunLine}<figcaption>{sunLine}</figcaption>{/if}
		</figure>
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if providers && now !== null}
					<WeekDial rings={rings("7-day")} {now} />
				{/if}
			</div>
			<figcaption>
				{dossier.moon.phaseName}, {Math.round(dossier.moon.illumination * 100)}% lit.
			</figcaption>
		</figure>
	</div>

	<div class="orloj-providers">
		{#if now !== null}
			{#each columns as { head } (head.provider.kind)}
				<ProviderPlate {...head} {drawn} {now} />
			{/each}
			{#each columns as { rest }, column (column)}
				{#if rest.length > 0}
					<div class="provider-column" style:grid-column={column + 1}>
						{#each rest as plate (plate.provider.kind)}
							<ProviderPlate {...plate} {drawn} {now} />
						{/each}
					</div>
				{/if}
			{/each}
		{/if}
	</div>
</section>
