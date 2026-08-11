<script lang="ts">
	import type { DayCell } from "$lib/calendar";
	import { formatRange } from "$lib/dates";
	import Check from "@lucide/svelte/icons/check";
	import MapPin from "@lucide/svelte/icons/map-pin";
	import PartyPopper from "@lucide/svelte/icons/party-popper";

	interface Person {
		id: string;
		firstName: string;
		shortName: string;
		initials: string;
		collegeName: string | null;
	}

	let {
		cell,
		peopleById,
		countedIds,
		referenceYear,
		allPeople,
		assumedIds,
	}: {
		cell: DayCell | null;
		peopleById: Map<string, Person>;
		countedIds: string[];
		referenceYear: number;
		allPeople: Person[];
		/** Anyone free today only because a federal holiday was filled in for them. */
		assumedIds: string[];
	} = $props();

	const assumedSet = $derived(new Set(assumedIds));
	const freeSet = $derived(new Set(cell?.freeIds ?? []));
	const free = $derived(
		(cell?.freeIds ?? []).map((id) => peopleById.get(id)).filter((p): p is Person => !!p),
	);
	const away = $derived(
		countedIds
			.filter((id) => !freeSet.has(id))
			.map((id) => peopleById.get(id))
			.filter((p): p is Person => !!p),
	);
	const silent = $derived(allPeople.filter((p) => !countedIds.includes(p.id)));
</script>

<div class="cal-panel detail">
	{#if !cell}
		<h3 class="detail-title">Pick a day</h3>
		<p class="detail-hint">
			Tap any square to see exactly who is off that day and who still has class.
		</p>
	{:else}
		<h3 class="detail-title">{formatRange(cell.iso, cell.iso, referenceYear)}</h3>

		{#if cell.allFree}
			<p class="detail-flag">
				<PartyPopper size={15} aria-hidden="true" />
				<!-- Not "Everyone is free" flat out when part of the answer is a filled-in default. That
				     is the line people plan around, so it has to carry its own caveat. -->
				{assumedIds.length > 0 ? "Everyone is free, if the defaults hold" : "Everyone is free"}
			</p>
		{:else if cell.freeCount === 0}
			<p class="detail-hint">Nobody is off on this day.</p>
		{:else}
			<p class="detail-count">{cell.freeCount} of {countedIds.length} free</p>
		{/if}

		{#if free.length > 0}
			<h4 class="detail-label">Off</h4>
			<ul class="detail-list">
				{#each free as person (person.id)}
					<li class="detail-row is-free" class:is-assumed={assumedSet.has(person.id)}>
						<span class="detail-avatar" aria-hidden="true">{person.initials}</span>
						<span class="detail-names">
							<span class="detail-name">{person.shortName}</span>
							{#if person.collegeName}
								<span class="detail-college">
									<MapPin size={11} aria-hidden="true" />
									<span class="detail-collegename">{person.collegeName}</span>
								</span>
							{/if}
						</span>
						{#if assumedSet.has(person.id)}
							<!-- A word, not a tick. The tick means somebody said so; this person said
							     nothing and the app filled a federal holiday in for them. -->
							<span class="detail-assumed">assumed</span>
						{:else}
							<Check class="detail-tick" size={15} aria-hidden="true" />
						{/if}
					</li>
				{/each}
			</ul>

			{#if assumedIds.length > 0}
				<p class="detail-note">
					Federal holidays are filled in as a default for work and military. They are not a check
					that anyone is actually off — duty, shifts, leave and training days are personal. Dates
					you enter yourself replace the default for those days.
				</p>
			{/if}
		{/if}

		{#if away.length > 0}
			<h4 class="detail-label">Still at school</h4>
			<ul class="detail-list">
				{#each away as person (person.id)}
					<li class="detail-row">
						<span class="detail-avatar is-muted" aria-hidden="true">{person.initials}</span>
						<span class="detail-names">
							<span class="detail-name">{person.shortName}</span>
							{#if person.collegeName}
								<span class="detail-college">
									<MapPin size={11} aria-hidden="true" />
									<span class="detail-collegename">{person.collegeName}</span>
								</span>
							{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/if}

		{#if silent.length > 0}
			<p class="detail-note">
				{silent.length}
				{silent.length === 1 ? "person has" : "people have"} nothing on the calendar yet — no dates of
				their own, and no institution the app knows a calendar for — so they are not counted:
				{silent.map((p) => p.firstName).join(", ")}.
			</p>
		{/if}
	{/if}
</div>

<style>
	.detail {
		min-width: 0;
	}

	.detail-title {
		font-size: 1rem;
		font-weight: 700;
		color: var(--cal-ink);
	}

	.detail-hint {
		margin-top: 6px;
		font-size: 0.86rem;
		line-height: 1.55;
		color: var(--cal-ink-2);
	}

	.detail-flag {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
		padding: 5px 10px;
		border-radius: 999px;
		background: var(--cal-free);
		color: var(--cal-free-ink);
		font-size: 0.82rem;
		font-weight: 700;
	}

	.detail-count {
		margin-top: 6px;
		font-size: 0.86rem;
		font-weight: 600;
		color: var(--cal-ink-2);
	}

	.detail-label {
		margin-top: 14px;
		margin-bottom: 6px;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--cal-ink-2);
	}

	.detail-list {
		display: flex;
		flex-direction: column;
		gap: 5px;
		list-style: none;
	}

	.detail-row {
		display: flex;
		align-items: center;
		gap: 9px;
		min-width: 0;
		padding: 6px 8px;
		border-radius: 9px;
		/* Transparent by default so the assumed variant can turn it on without moving the row. */
		border: 1px solid transparent;
		background: var(--cal-recess);
	}

	.detail-row.is-free {
		background: var(--cal-free-tint);
	}

	/* Dashed, and without the solid free tint: the row is a placeholder, and it should not look as
	   settled as the rows next to it that somebody actually stands behind. */
	.detail-row.is-free.is-assumed {
		background: var(--cal-recess);
		border: 1px dashed var(--cal-border-strong);
	}

	.detail-assumed {
		flex: 0 0 auto;
		padding: 1px 7px;
		border-radius: 999px;
		border: 1px solid var(--cal-border-strong);
		color: var(--cal-ink-2);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.detail-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--cal-accent);
		color: var(--cal-accent-ink);
		font-size: 0.68rem;
		font-weight: 700;
	}

	.detail-avatar.is-muted {
		background: var(--cal-border-strong);
		color: var(--cal-ink);
	}

	.detail-names {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1 1 auto;
	}

	.detail-name {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--cal-ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail-college {
		display: flex;
		align-items: center;
		gap: 3px;
		font-size: 0.74rem;
		color: var(--cal-ink-2);
		min-width: 0;
	}

	.detail-college :global(svg) {
		flex: 0 0 auto;
	}

	/* text-overflow does not apply to a flex container, only to a block box,
	   so the name needs its own element to ellipsize inside. */
	.detail-collegename {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail-row :global(.detail-tick) {
		flex: 0 0 auto;
		color: var(--cal-free);
	}

	.detail-note {
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid var(--cal-border);
		font-size: 0.78rem;
		line-height: 1.5;
		color: var(--cal-ink-2);
	}
</style>
