<script lang="ts">
	import { resolve } from "$app/paths";
	import {
		assumedFreeIds,
		buildMonthView,
		pickInitialMonth,
		shiftMonth,
		toParticipants,
		WEEKDAY_LABELS,
	} from "$lib/calendar";
	import BreakDayDetail from "$lib/components/BreakDayDetail.svelte";
	import BreakEditor from "$lib/components/BreakEditor.svelte";
	import { addDays, formatRange, startOfMonth } from "$lib/dates";
	import { buildReport } from "$lib/overlap";
	import ArrowLeft from "@lucide/svelte/icons/arrow-left";
	import CalendarDays from "@lucide/svelte/icons/calendar-days";
	import CalendarOff from "@lucide/svelte/icons/calendar-off";
	import ChevronLeft from "@lucide/svelte/icons/chevron-left";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";
	import Info from "@lucide/svelte/icons/info";
	import PartyPopper from "@lucide/svelte/icons/party-popper";
	import { untrack } from "svelte";

	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();

	const participants = $derived(toParticipants(data.people, data.breaks));
	const peopleById = $derived(new Map(data.people.map((p) => [p.id, p])));
	const referenceYear = $derived(Number(data.todayIso.slice(0, 4)));

	// Deliberately read once, at mount: the month worth opening on is a starting
	// position, not a value that should snap back when the data reloads.
	let month = $state(
		untrack(() => pickInitialMonth(toParticipants(data.people, data.breaks), data.todayIso)),
	);

	const view = $derived(buildMonthView(participants, month, { todayIso: data.todayIso }));
	const report = $derived(buildReport(participants, { todayIso: data.todayIso }));
	const countedCount = $derived(view.countedIds.length);

	const flatCells = $derived(view.weeks.flat());

	function firstInterestingDay(): string | null {
		const cells = buildMonthView(
			toParticipants(data.people, data.breaks),
			pickInitialMonth(toParticipants(data.people, data.breaks), data.todayIso),
			{ todayIso: data.todayIso },
		).weeks.flat();
		return (
			cells.find((c) => c.inMonth && c.allFree)?.iso ??
			cells.find((c) => c.isToday)?.iso ??
			cells.find((c) => c.inMonth && c.freeCount > 0)?.iso ??
			null
		);
	}

	let selectedIso = $state<string | null>(untrack(() => firstInterestingDay()));
	let focusIso = $state<string | null>(null);

	const selectedCell = $derived(flatCells.find((c) => c.iso === selectedIso) ?? null);

	// Who is on the free list for the selected day only because the app filled a federal holiday in
	// for them. The grid reduces every break to a day range and forgets its source, so the detail
	// panel has to ask separately rather than reading it off the cell.
	const assumedIds = $derived(assumedFreeIds(data.breaks, selectedCell?.iso ?? null));

	// The cell that owns tabindex 0. Keeps the grid to a single tab stop.
	const rovingIso = $derived(
		focusIso ??
			selectedIso ??
			flatCells.find((c) => c.isToday)?.iso ??
			flatCells.find((c) => c.inMonth)?.iso ??
			null,
	);

	let gridEl: HTMLDivElement | undefined = $state();
	let pendingFocus = $state(false);

	$effect(() => {
		if (!pendingFocus || !focusIso || !gridEl) return;
		const target = gridEl.querySelector<HTMLElement>(`[data-iso="${focusIso}"]`);
		target?.focus();
		pendingFocus = false;
	});

	function goToMonth(next: string) {
		month = next;
		selectedIso = null;
		focusIso = null;
	}

	function goToday() {
		month = startOfMonth(data.todayIso);
		selectedIso = data.todayIso;
		focusIso = null;
	}

	function moveFocus(delta: number) {
		const from = rovingIso;
		if (!from) return;
		const next = addDays(from, delta);
		if (startOfMonth(next) !== month) {
			month = startOfMonth(next);
		}
		focusIso = next;
		pendingFocus = true;
	}

	function onGridKeydown(event: KeyboardEvent) {
		const moves: Record<string, number> = {
			ArrowLeft: -1,
			ArrowRight: 1,
			ArrowUp: -7,
			ArrowDown: 7,
		};
		if (event.key in moves) {
			event.preventDefault();
			moveFocus(moves[event.key]);
			return;
		}
		if (event.key === "PageUp" || event.key === "PageDown") {
			event.preventDefault();
			goToMonth(shiftMonth(month, event.key === "PageUp" ? -1 : 1));
		}
	}

	function describe(cell: (typeof flatCells)[number]): string {
		const date = formatRange(cell.iso, cell.iso, referenceYear);
		if (countedCount === 0) return date;
		if (cell.allFree) return `${date}, everyone is free`;
		if (cell.freeCount === 0) return `${date}, nobody is off`;
		return `${date}, ${String(cell.freeCount)} of ${String(countedCount)} free`;
	}

	// The one line under the month title. It is the calendar's own subtitle,
	// which is why it talks about this month and not the whole year.
	const monthSummary = $derived.by(() => {
		if (countedCount === 0) return "Nobody has added a break yet.";
		if (countedCount === 1) return "Only one person has added breaks so far.";
		if (view.allFreeDays === 0)
			return `No day this month works for all ${String(countedCount)} of you.`;
		const d = view.allFreeDays;
		return `${String(d)} ${d === 1 ? "day" : "days"} this month when all ${String(countedCount)} of you are free.`;
	});

	const nextAllFree = $derived(report.everyone.toSorted((a, b) => a.startDay - b.startDay).at(0));
	const closestMiss = $derived(report.almost.at(0));

	function jumpTo(iso: string) {
		month = startOfMonth(iso);
		selectedIso = iso;
		focusIso = null;
	}
</script>

<svelte:head>
	<title>Break Calendar - College Map</title>
	<meta name="description" content="See when everyone's college breaks line up." />
</svelte:head>

<div class="cal-root">
	<header class="cal-header">
		<a class="cal-back" href={resolve("/")}>
			<ArrowLeft size={16} aria-hidden="true" />
			<span>Map</span>
		</a>
		<div class="cal-brand">
			<CalendarDays size={19} aria-hidden="true" />
			<h1>Break Calendar</h1>
		</div>
		<div class="cal-header-right">
			{#if data.meId}
				<a class="cal-link" href={resolve("/profile")}>Profile</a>
			{:else}
				<a class="cal-link" href={resolve("/login")}>Log in</a>
			{/if}
		</div>
	</header>

	<main class="cal-main">
		<section class="cal-primary" aria-label="Break calendar">
			<div class="cal-toolbar">
				<div class="cal-monthline">
					<button
						class="cal-step"
						type="button"
						onclick={() => {
							goToMonth(shiftMonth(month, -1));
						}}
						aria-label="Previous month"
					>
						<ChevronLeft size={18} aria-hidden="true" />
					</button>
					<h2 class="cal-month" aria-live="polite">{view.label}</h2>
					<button
						class="cal-step"
						type="button"
						onclick={() => {
							goToMonth(shiftMonth(month, 1));
						}}
						aria-label="Next month"
					>
						<ChevronRight size={18} aria-hidden="true" />
					</button>
					<button class="cal-today" type="button" onclick={goToday}>Today</button>
				</div>
				<p class="cal-summary">{monthSummary}</p>
			</div>

			{#if nextAllFree && startOfMonth(nextAllFree.start) !== month}
				<button
					class="cal-jump"
					type="button"
					onclick={() => {
						jumpTo(nextAllFree.start);
					}}
				>
					<PartyPopper size={15} aria-hidden="true" />
					<span
						>Everyone is free {formatRange(nextAllFree.start, nextAllFree.end, referenceYear)}</span
					>
					<span class="cal-jump-go">Jump there</span>
				</button>
			{/if}

			<div
				class="cal-grid-wrap"
				role="application"
				aria-label="Month grid. Use the arrow keys to move between days."
			>
				<div class="cal-weekdays" aria-hidden="true">
					{#each WEEKDAY_LABELS as label (label)}
						<span class="cal-weekday"
							>{label.charAt(0)}<span class="cal-weekday-rest">{label.slice(1)}</span></span
						>
					{/each}
				</div>

				<div
					class="cal-grid"
					bind:this={gridEl}
					onkeydown={onGridKeydown}
					role="grid"
					tabindex="-1"
				>
					{#each view.weeks as week, wi (wi)}
						<div class="cal-week" role="row">
							{#each week as cell (cell.iso)}
								{@const freeSet = new Set(cell.freeIds)}
								<div role="gridcell" class="cal-cellwrap">
									<button
										type="button"
										data-iso={cell.iso}
										class="cal-day"
										class:is-out={!cell.inMonth}
										class:is-today={cell.isToday}
										class:is-selected={cell.iso === selectedIso}
										class:is-allfree={cell.allFree}
										class:is-empty={cell.freeCount === 0}
										tabindex={cell.iso === rovingIso ? 0 : -1}
										aria-pressed={cell.iso === selectedIso}
										aria-label={describe(cell)}
										onclick={() => {
											selectedIso = cell.iso;
											focusIso = cell.iso;
											if (!cell.inMonth) month = startOfMonth(cell.iso);
										}}
									>
										<span class="cal-daynum">{cell.dayOfMonth}</span>
										{#if cell.freeCount > 0 && countedCount > 0}
											<span class="cal-daycount">{cell.freeCount}</span>
										{/if}
										{#if cell.freeCount > 0}
											<span class="cal-strip" aria-hidden="true">
												{#each view.countedIds as id (id)}
													<span class="cal-seg" class:on={freeSet.has(id)}></span>
												{/each}
											</span>
										{/if}
									</button>
								</div>
							{/each}
						</div>
					{/each}
				</div>
			</div>

			{#if countedCount > 0}
				<div class="cal-legend">
					<span class="cal-legend-item">
						<span class="cal-swatch is-allfree"></span>
						Everyone free
					</span>
					<span class="cal-legend-item">
						<span class="cal-swatch is-some"></span>
						Some free
					</span>
					<span class="cal-legend-note">
						<Info size={13} aria-hidden="true" />
						Each notch is one person, in the same order every day.
					</span>
				</div>
			{/if}
		</section>

		<aside class="cal-side">
			{#if countedCount === 0}
				<div class="cal-panel cal-onboard">
					<CalendarOff size={22} aria-hidden="true" />
					<h3>The calendar is empty</h3>
					<p>
						Nobody has added a break yet. Add yours below and it appears on these dates straight
						away. Once two of you have added dates, the days you are all free light up.
					</p>
				</div>
			{:else}
				<BreakDayDetail
					cell={selectedCell}
					{peopleById}
					countedIds={view.countedIds}
					{referenceYear}
					allPeople={data.people}
					{assumedIds}
				/>
			{/if}

			{#if countedCount > 0 && report.everyone.length === 0 && closestMiss}
				<div class="cal-panel cal-nearmiss">
					<h3>Closest anyone gets</h3>
					<p class="cal-nearmiss-range">
						{formatRange(closestMiss.start, closestMiss.end, referenceYear)}
					</p>
					<p class="cal-nearmiss-body">
						{closestMiss.freeIds.length} of {countedCount} free, missing
						{closestMiss.missingIds
							.map((id) => peopleById.get(id)?.firstName ?? "someone")
							.join(", ")}.
					</p>
					<button
						class="cal-textbtn"
						type="button"
						onclick={() => {
							jumpTo(closestMiss.start);
						}}
					>
						Show me
					</button>
				</div>
			{/if}

			<BreakEditor meId={data.meId} breaks={data.breaks} {referenceYear} {form} />
		</aside>
	</main>
</div>

<style>
	.cal-root {
		/* Feature-scoped tokens. Every value below was measured with a WCAG
		   contrast script, not eyeballed; see the ratios in the review notes.
		   Scoped rather than global because the rest of College Map has no dark
		   theme, and silently darkening the map is not this change's job. */
		--cal-page: #f8fafc;
		--cal-surface: #ffffff;
		--cal-recess: #f1f5f9;
		--cal-border: #e2e8f0;
		--cal-border-strong: #cbd5e1;
		--cal-ink: #0f172a; /* 17.85:1 on surface */
		--cal-ink-2: #41505f; /* 8.28:1 on surface, 7.55:1 on recess, 7.30:1 on free tint */
		--cal-accent: #3b31b0; /* 9.32:1 on surface, 8.22:1 on free tint */
		--cal-accent-ink: #ffffff; /* 9.32:1 on accent */
		--cal-accent-tint: #eef2ff;
		--cal-free: #065f46;
		--cal-free-ink: #ffffff; /* 7.68:1 on free */
		--cal-free-tint: #d1fae5;
		--cal-seg-on: #3b31b0;
		--cal-seg-off: #dbe1ea;
		--cal-shadow: 0 4px 24px rgba(15, 23, 42, 0.06);
		--cal-ring: 0 0 0 2px var(--cal-accent);

		--z-base: 1;
		--z-sticky: 100;

		min-height: 100vh;
		min-height: 100dvh;
		background: var(--cal-page);
		color: var(--cal-ink);
	}

	@media (prefers-color-scheme: dark) {
		.cal-root {
			--cal-page: #0b1120;
			--cal-surface: #151c2c;
			/* Darker than the surface so a recessed tile reads as pushed back,
			   which is the only cue separating a neighbouring month's days. */
			--cal-recess: #0a0f1c;
			--cal-border: #2a3550;
			--cal-border-strong: #3b4767;
			--cal-ink: #f8fafc; /* 16.26:1 on surface */
			--cal-ink-2: #cbd5e1; /* 11.46:1 on surface */
			--cal-accent: #c7d2fe; /* 11.41:1 on surface */
			--cal-accent-ink: #10182c;
			--cal-accent-tint: #1e2740;
			--cal-free: #34d399;
			--cal-free-ink: #052e1f; /* 7.71:1 on free */
			--cal-free-tint: #14342c;
			--cal-seg-on: #818cf8;
			--cal-seg-off: #334155;
			--cal-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
		}
	}

	:global(.cal-root *) {
		box-sizing: border-box;
	}

	/* Header: same shape and rhythm as the map header so this reads as one app. */
	.cal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 10px 16px;
		background: var(--cal-surface);
		border-bottom: 1px solid var(--cal-border);
		position: sticky;
		top: 0;
		z-index: var(--z-sticky);
	}

	.cal-brand {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--cal-accent);
		min-width: 0;
	}

	.cal-brand h1 {
		font-size: 1rem;
		font-weight: 700;
		color: var(--cal-ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cal-back,
	.cal-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--cal-ink-2);
		text-decoration: none;
		font-size: 0.85rem;
		font-weight: 500;
		padding: 6px 10px;
		border-radius: 8px;
		border: 1px solid transparent;
		white-space: nowrap;
	}

	.cal-back:hover,
	.cal-link:hover {
		background: var(--cal-recess);
		color: var(--cal-ink);
	}

	.cal-back:focus-visible,
	.cal-link:focus-visible,
	.cal-step:focus-visible,
	.cal-today:focus-visible,
	.cal-jump:focus-visible,
	.cal-textbtn:focus-visible {
		outline: none;
		box-shadow: var(--cal-ring);
	}

	.cal-header-right {
		display: flex;
		justify-content: flex-end;
	}

	.cal-back,
	.cal-header-right {
		flex: 1 1 0;
		min-width: 0;
	}

	.cal-back {
		justify-content: flex-start;
	}

	.cal-main {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
		padding: 16px 12px 48px;
		max-width: 1180px;
		margin: 0 auto;
	}

	@media (min-width: 900px) {
		.cal-main {
			grid-template-columns: minmax(0, 1fr) 320px;
			align-items: start;
			padding: 20px 20px 56px;
			gap: 20px;
		}
	}

	.cal-primary {
		min-width: 0;
	}

	.cal-toolbar {
		margin-bottom: 12px;
	}

	.cal-monthline {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.cal-month {
		font-size: 1.15rem;
		font-weight: 700;
		color: var(--cal-ink);
		margin: 0 4px;
		min-width: 0;
		flex: 1 1 auto;
	}

	@media (min-width: 560px) {
		.cal-month {
			flex: 0 0 auto;
			min-width: 11ch;
		}
	}

	.cal-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		flex: 0 0 auto;
		border-radius: 9px;
		border: 1px solid var(--cal-border);
		background: var(--cal-surface);
		color: var(--cal-ink-2);
		cursor: pointer;
		transition:
			background 180ms cubic-bezier(0.22, 1, 0.36, 1),
			color 180ms;
	}

	.cal-step:hover {
		background: var(--cal-recess);
		color: var(--cal-ink);
	}

	.cal-today {
		margin-left: auto;
		flex: 0 0 auto;
		padding: 7px 12px;
		border-radius: 9px;
		border: 1px solid var(--cal-border);
		background: var(--cal-surface);
		color: var(--cal-ink-2);
		font-size: 0.82rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			background 180ms cubic-bezier(0.22, 1, 0.36, 1),
			color 180ms;
	}

	.cal-today:hover {
		background: var(--cal-recess);
		color: var(--cal-ink);
	}

	.cal-summary {
		margin-top: 6px;
		font-size: 0.88rem;
		color: var(--cal-ink-2);
		line-height: 1.45;
		max-width: 62ch;
	}

	.cal-jump {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		margin-bottom: 12px;
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--cal-border);
		background: var(--cal-free-tint);
		color: var(--cal-ink);
		font-size: 0.85rem;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
	}

	.cal-jump > span:first-of-type {
		min-width: 0;
		flex: 1 1 auto;
	}

	.cal-jump-go {
		flex: 0 0 auto;
		font-weight: 700;
		color: var(--cal-accent);
		text-decoration: underline;
	}

	.cal-grid-wrap {
		background: var(--cal-surface);
		border: 1px solid var(--cal-border);
		border-radius: 14px;
		padding: 10px;
		box-shadow: var(--cal-shadow);
	}

	.cal-weekdays,
	.cal-week {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 4px;
	}

	.cal-weekday {
		text-align: center;
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--cal-ink-2);
		padding-bottom: 6px;
		letter-spacing: 0.01em;
	}

	.cal-weekday-rest {
		display: none;
	}

	@media (min-width: 520px) {
		.cal-weekday-rest {
			display: inline;
		}
	}

	.cal-grid {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.cal-cellwrap {
		min-width: 0;
	}

	.cal-day {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		height: 100%;
		min-height: 58px;
		padding: 5px 5px 8px;
		border-radius: 9px;
		border: 1px solid var(--cal-border);
		background: var(--cal-surface);
		color: var(--cal-ink);
		cursor: pointer;
		text-align: left;
		transition:
			transform 160ms cubic-bezier(0.22, 1, 0.36, 1),
			box-shadow 160ms cubic-bezier(0.22, 1, 0.36, 1),
			background 160ms;
	}

	@media (min-width: 700px) {
		.cal-day {
			min-height: 84px;
			padding: 8px 8px 11px;
			border-radius: 11px;
		}
	}

	.cal-day:hover {
		box-shadow: 0 2px 10px rgba(15, 23, 42, 0.1);
		transform: translateY(-1px);
	}

	.cal-day:focus-visible {
		outline: none;
		box-shadow: var(--cal-ring);
		z-index: var(--z-base);
	}

	.cal-day.is-out {
		background: var(--cal-recess);
		border-color: transparent;
	}

	.cal-day.is-empty {
		background: var(--cal-surface);
	}

	.cal-day.is-out.is-empty {
		background: var(--cal-recess);
	}

	.cal-day.is-today {
		border-color: var(--cal-accent);
		border-width: 2px;
		padding: 4px 4px 7px;
	}

	@media (min-width: 700px) {
		.cal-day.is-today {
			padding: 7px 7px 10px;
		}
	}

	/* The strongest state on the page. Nothing else is a solid saturated block. */
	.cal-day.is-allfree {
		background: var(--cal-free);
		border-color: var(--cal-free);
		color: var(--cal-free-ink);
	}

	.cal-day.is-allfree.is-out {
		background: var(--cal-free-tint);
		border-color: transparent;
		color: var(--cal-ink);
	}

	.cal-day.is-selected {
		box-shadow: var(--cal-ring);
	}

	.cal-daynum {
		font-size: 0.8rem;
		font-weight: 600;
		line-height: 1.1;
		font-variant-numeric: tabular-nums;
	}

	@media (min-width: 700px) {
		.cal-daynum {
			font-size: 0.9rem;
		}
	}

	.cal-day.is-out .cal-daynum {
		color: var(--cal-ink-2);
		font-weight: 500;
	}

	.cal-day.is-allfree.is-out .cal-daynum {
		color: var(--cal-ink);
	}

	.cal-daycount {
		position: absolute;
		top: 5px;
		right: 6px;
		font-size: 0.7rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--cal-ink-2);
		line-height: 1;
	}

	@media (min-width: 700px) {
		.cal-daycount {
			top: 8px;
			right: 9px;
			font-size: 0.78rem;
		}
	}

	.cal-day.is-allfree .cal-daycount {
		color: var(--cal-free-ink);
	}

	.cal-day.is-allfree.is-out .cal-daycount {
		color: var(--cal-ink-2);
	}

	/* One notch per counted person, always in the same order, so a column of
	   notches reads as one person's stretch of days off. */
	.cal-strip {
		display: flex;
		gap: 1px;
		width: 100%;
		margin-top: auto;
		padding-top: 6px;
	}

	.cal-seg {
		flex: 1 1 0;
		min-width: 0;
		height: 4px;
		border-radius: 1px;
		background: var(--cal-seg-off);
	}

	@media (min-width: 700px) {
		.cal-seg {
			height: 6px;
			border-radius: 2px;
		}
	}

	.cal-seg.on {
		background: var(--cal-seg-on);
	}

	.cal-day.is-allfree .cal-seg.on {
		background: var(--cal-free-ink);
	}

	.cal-day.is-allfree.is-out .cal-seg.on {
		background: var(--cal-free);
	}

	.cal-legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 16px;
		margin-top: 12px;
		font-size: 0.8rem;
		color: var(--cal-ink-2);
	}

	.cal-legend-item,
	.cal-legend-note {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.cal-swatch {
		width: 13px;
		height: 13px;
		border-radius: 4px;
		flex: 0 0 auto;
	}

	.cal-swatch.is-allfree {
		background: var(--cal-free);
	}

	.cal-swatch.is-some {
		background: var(--cal-surface);
		border: 1px solid var(--cal-border-strong);
		box-shadow: inset 0 -4px 0 -1px var(--cal-seg-on);
	}

	.cal-side {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	/* The detail panel plus the editor run taller than the grid, which on a wide
	   screen left most of the left-hand column empty. Pinning the column and
	   letting it scroll on its own keeps the page as tall as the calendar.
	   Header is 55px, so 71px clears it with the same 16px rhythm as the gap. */
	@media (min-width: 900px) {
		.cal-side {
			position: sticky;
			top: 71px;
			max-height: calc(100dvh - 87px);
			overflow-y: auto;
			scrollbar-gutter: stable;
		}
	}

	:global(.cal-panel) {
		background: var(--cal-surface);
		border: 1px solid var(--cal-border);
		border-radius: 14px;
		padding: 16px;
		box-shadow: var(--cal-shadow);
		min-width: 0;
	}

	.cal-onboard {
		text-align: left;
		color: var(--cal-accent);
	}

	.cal-onboard h3 {
		margin-top: 8px;
		font-size: 1rem;
		font-weight: 700;
		color: var(--cal-ink);
	}

	.cal-onboard p {
		margin-top: 6px;
		font-size: 0.86rem;
		line-height: 1.55;
		color: var(--cal-ink-2);
	}

	.cal-nearmiss h3 {
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--cal-ink);
	}

	.cal-nearmiss-range {
		margin-top: 6px;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--cal-ink);
	}

	.cal-nearmiss-body {
		margin-top: 4px;
		font-size: 0.85rem;
		line-height: 1.5;
		color: var(--cal-ink-2);
	}

	.cal-textbtn {
		margin-top: 8px;
		padding: 0;
		border: none;
		background: none;
		color: var(--cal-accent);
		font-size: 0.85rem;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
		border-radius: 4px;
	}

	@media (prefers-reduced-motion: reduce) {
		.cal-day,
		.cal-step,
		.cal-today {
			transition: none;
		}

		.cal-day:hover {
			transform: none;
		}
	}
</style>
