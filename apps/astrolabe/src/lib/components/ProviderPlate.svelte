<script lang="ts">
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

	import { formatDuration } from "#lib/format.ts";
	import type { LimitReading } from "#lib/limits.ts";
	import type { UsageReadout } from "#lib/server/dossier.ts";

	import LimitRow from "./LimitRow.svelte";

	let {
		provider,
		readings,
		notes,
		order,
		drawn,
		now,
	}: {
		provider: UsageReadout;
		readings: LimitReading[];
		/** What the feed reports that no row shows, such as a service it could not read. */
		notes: string[];
		/** The plate's place among the providers, which a single column lays them out in. */
		order: number;
		/** Ids of the limits a dial has a ring for. */
		drawn: ReadonlySet<string>;
		now: number;
	} = $props();

	const STALE_AFTER_MS = 15 * 60 * 1000;

	const facts = $derived.by(() => {
		const observedAt = provider.observedAt === null ? null : provider.observedAt * 1000;

		return [
			provider.creditsBalance === null
				? null
				: `${new Intl.NumberFormat().format(Math.round(provider.creditsBalance))} credits left`,
			observedAt !== null && now - observedAt > STALE_AFTER_MS
				? `Last read ${formatDuration(now - observedAt)} ago`
				: null,
		].filter((fact) => fact !== null);
	});
</script>

<!-- One brass plate per provider: its plan, then each limit it reports as a row under an engraved rule. -->
<section
	class="brass-plate provider-plate"
	style:--order={order}
	aria-labelledby="provider-{provider.kind}"
>
	<div class="brass-plate-face provider-plate-face">
		<h2 id="provider-{provider.kind}">
			{provider.label}{#if provider.plan}<span class="plate-status">{provider.plan}</span>{/if}
		</h2>
		{#each readings as reading (reading.window.id)}
			<LimitRow {reading} {now} onDial={drawn.has(reading.window.id)} />
		{:else}
			<!-- A service that could not be read says so in the notes instead. -->
			{#if provider.status === "ok"}
				<p class="provider-empty">{provider.awaiting ? "Awaiting data" : "No reading"}</p>
			{/if}
		{/each}
		{#if facts.length > 0 || notes.length > 0}
			<ul class="provider-notes">
				{#each facts as fact (fact)}
					<li>{fact}</li>
				{/each}
				{#each notes as note (note)}
					<li class="alarm">
						<TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />{note}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>
