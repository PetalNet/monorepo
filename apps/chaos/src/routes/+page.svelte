<script lang="ts">
	import Bank from "#lib/components/Bank.svelte";
	import Countdown from "#lib/components/Countdown.svelte";
	import DoorReading from "#lib/components/DoorReading.svelte";
	import DoorStrip from "#lib/components/DoorStrip.svelte";
	import HitBox from "#lib/components/HitBox.svelte";
	import StatusBoard from "#lib/components/StatusBoard.svelte";
	import { weekday } from "#lib/format.ts";

	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();

	const today = $derived(data.strip.find((door) => door.state === "today"));
</script>

<main>
	<dl class="readouts">
		<div>
			<dt>Door clock, US Eastern</dt>
			<dd>{weekday(data.date)}</dd>
		</div>
		<div>
			<dt>{data.next ? `${data.next.label} opens in` : "Doors"}</dt>
			<dd>
				{#if data.next}<Countdown to={data.next.opensAt} from={data.now} />{:else}All open{/if}
			</dd>
		</div>
		<div>
			<dt>Exploited vulnerabilities on CISA's list</dt>
			<dd>{data.checkedAt ? data.catalogSize.toLocaleString("en-US") : "No reading"}</dd>
		</div>
		<div>
			<dt>Added today</dt>
			<dd>{today ? (data.addedToday ?? "No reading") : "Season over"}</dd>
		</div>
	</dl>

	<Bank
		chaos={data.chaos}
		risk={data.risk}
		ics={data.ics.gauge}
		safety={data.safety}
		gap={data.gap}
		kevCheckedAt={data.checkedAt}
		icsCheckedAt={data.ics.checkedAt}
	/>

	<DoorStrip strip={data.strip} selected={data.reading.door.id} />

	{#key data.reading.door.id}
		<DoorReading reading={data.reading} date={data.date} checkedAt={data.checkedAt} />
	{/key}

	<StatusBoard board={data.board} />

	<HitBox check={data.hit} door={data.reading.door.id} />
</main>

<style>
	main {
		display: grid;
		gap: 1.5rem;
	}
	.readouts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem 1.5rem;
		margin: 0;
		padding-block: 1rem;
		border-block: 1px solid var(--color-rule);
	}
	@media (min-width: 60rem) {
		.readouts {
			grid-template-columns: 1.3fr 1.2fr 1.5fr 0.8fr;
		}
	}
	dt {
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	dd {
		margin: 0;
		font-size: 1.125rem;
	}
</style>
