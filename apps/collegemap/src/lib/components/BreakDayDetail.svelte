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
	/**
	 * Whoever was off yesterday has _returned_; everyone else never left. January is the month that
	 * makes the difference visible, and one blanket "Still at school" was wrong for half the list in
	 * it.
	 */
	const returningSet = $derived(new Set(cell?.returningIds ?? []));

	/** The panel's three lists, in the order they are worth reading. */
	const groups = $derived(
		[
			{ heading: "Off", people: free, off: true },
			{ heading: "Back at school", people: away.filter((p) => returningSet.has(p.id)), off: false },
			{
				heading: "Still at school",
				people: away.filter((p) => !returningSet.has(p.id)),
				off: false,
			},
		].filter((g) => g.people.length > 0),
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

		{#each groups as group (group.heading)}
			<h4 class="detail-label">{group.heading}</h4>
			<ul class="detail-list">
				{#each group.people as person (person.id)}
					{@const assumed = group.off && assumedSet.has(person.id)}
					{@const why = group.off ? (cell?.reasons.get(person.id) ?? []) : []}
					<li class="detail-row" class:is-free={group.off} class:is-assumed={assumed}>
						<span class="detail-avatar" class:is-muted={!group.off} aria-hidden="true"
							>{person.initials}</span
						>
						<span class="detail-names">
							<span class="detail-name">{person.shortName}</span>
							{#if person.collegeName}
								<span class="detail-college">
									<MapPin size={11} aria-hidden="true" />
									<span class="detail-collegename">{person.collegeName}</span>
								</span>
							{/if}
							{#if why.length > 0}
								<span class="detail-reasons">
									{#each why as reason (reason.label)}
										<span class="detail-reason" data-season={reason.season} title={reason.label}
											>{reason.name}</span
										>
									{/each}
								</span>
							{/if}
						</span>
						{#if assumed}
							<!-- A word, not a tick. The tick means somebody said so; this person said
							     nothing and the app filled a federal holiday in for them. -->
							<span class="detail-assumed">assumed</span>
						{:else if group.off}
							<Check class="detail-tick" size={15} aria-hidden="true" />
						{/if}
					</li>
				{/each}
			</ul>

			{#if group.off && assumedIds.length > 0}
				<p class="detail-note">
					Federal holidays are filled in as a default for work and military. They are not a check
					that anyone is actually off — duty, shifts, leave and training days are personal. Dates
					you enter yourself replace the default for those days.
				</p>
			{/if}
		{/each}

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
		font-weight: 600;
		color: var(--cal-ink);
	}

	.detail-hint {
		margin-block-start: var(--space-2);
		font-size: 0.86rem;
		line-height: 1.55;
		color: var(--cal-ink-2);
	}

	.detail-flag {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-block-start: var(--space-2);
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius);
		background: var(--cal-free);
		color: var(--cal-free-ink);
		font-size: 0.82rem;
		font-weight: 600;
	}

	.detail-count {
		margin-block-start: var(--space-2);
		font-size: 0.86rem;
		font-weight: 600;
		color: var(--cal-ink-2);
	}

	.detail-label {
		margin-block-start: var(--space-4);
		margin-block-end: var(--space-2);
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--cal-ink-2);
	}

	.detail-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		list-style: none;
	}

	/* A filled tile, like every other row on the page. The fill is what separates
	   it from the panel, so there is no border to draw. */
	.detail-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		padding: var(--space-2);
		border-radius: var(--radius);
		background: var(--cal-recess);
	}

	.detail-row.is-free {
		background: var(--cal-free-tint);
	}

	/* Dashed, and without the solid free tint: the row is a placeholder and should not look as
	   settled as the rows next to it that somebody actually stands behind. An inset outline rather
	   than a border, so the row keeps its size and the dashes hug the radius. */
	.detail-row.is-free.is-assumed {
		background: var(--cal-recess);
		outline: 1px dashed var(--cal-fill-strong);
		outline-offset: -1px;
	}

	.detail-assumed {
		flex: 0 0 auto;
		padding: 0 var(--space-1);
		border-radius: var(--radius);
		background: var(--cal-fill-strong);
		color: var(--cal-ink);
		font-size: 0.68rem;
		font-weight: 600;
	}

	.detail-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--cal-accent);
		color: var(--cal-accent-ink);
		font-size: 0.68rem;
		font-weight: 600;
	}

	.detail-avatar.is-muted {
		background: var(--cal-fill-strong);
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
		gap: var(--space-1);
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

	/* The reason sits on the person, not above the list: two people can be off on
	   the same day for two different breaks, and one person for two at once. */
	.detail-reasons {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin-block-start: var(--space-1);
		min-width: 0;
	}

	/* Seasonal, but only here and on the day-cell dot. The grid fill is the data,
	   filled means everyone is free, and no season is allowed near it. Every pair
	   is measured by calendar-style.test.ts. */
	.detail-reason {
		max-width: 100%;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius);
		background: var(--season-bg);
		color: var(--season-ink);
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.5;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail-row :global(.detail-tick) {
		flex: 0 0 auto;
		color: var(--cal-free);
	}

	.detail-note {
		margin-block-start: var(--space-3);
		padding-block-start: var(--space-2);
		border-block-start: 1px solid var(--cal-rule);
		font-size: 0.78rem;
		line-height: 1.5;
		color: var(--cal-ink-2);
	}
</style>
