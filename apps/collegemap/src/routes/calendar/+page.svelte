<script lang="ts">
	import { resolve } from "$app/paths";
	import {
		assumedFreeIds,
		buildMonthView,
		distinctReasons,
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

	const view = $derived(
		buildMonthView(participants, month, { todayIso: data.todayIso, breaks: data.breaks }),
	);
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

	/**
	 * Names as one spoken phrase, capped.
	 *
	 * Eleven friends at eleven colleges spell one Labor Day eleven different ways, and reading all of
	 * them out is worse than saying how many there are.
	 */
	function listSentence(names: string[], limit: number): string {
		const shown = names.slice(0, limit);
		const rest = names.length - shown.length;
		const parts = rest > 0 ? [...shown, `${String(rest)} more`] : shown;
		if (parts.length === 1) return parts[0];
		return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
	}

	function describe(cell: (typeof flatCells)[number]): string {
		const date = formatRange(cell.iso, cell.iso, referenceYear);
		if (countedCount === 0) return date;
		if (cell.freeCount === 0) return `${date}, nobody is off`;
		// The reason is the part a screen reader had no way to reach: the grid draws a green
		// square and the label said only how many people it stood for.
		const names = distinctReasons(cell).map((r) => r.name);
		const why = names.length > 0 ? `, for ${listSentence(names, 2)}` : "";
		if (cell.allFree) return `${date}, everyone is free${why}`;
		return `${date}, ${String(cell.freeCount)} of ${String(countedCount)} free${why}`;
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
										<span class="cal-dayhead">
											<span class="cal-daynum">{cell.dayOfMonth}</span>
											{#if cell.season}
												<span class="cal-daymark" data-season={cell.season} aria-hidden="true"
												></span>
											{/if}
										</span>
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
						Each notch is one person, in the same order every day. A dot beside the date means the day
						has a named break; pick it to read the names.
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
		/* One token set for the whole calendar surface: colour, shape, rhythm,
		   elevation, motion. Feature-scoped rather than global because the rest of
		   College Map has no dark theme, and silently darkening the map is not this
		   change's job. Every colour pair is measured by
		   src/lib/calendar-contrast.test.ts, never eyeballed. */
		--cal-page: #eceff4;
		--cal-surface: #ffffff;
		--cal-recess: #f1f5f9;
		/* A hairline rule, not a border: it separates two surfaces, it never wraps
		   one. Nothing on this page draws a box. */
		--cal-rule: #e2e8f0;
		--cal-fill-strong: #cbd5e1;
		--cal-ink: #0f172a;
		--cal-ink-2: #41505f;
		--cal-accent: #3b31b0;
		--cal-accent-ink: #ffffff;
		--cal-accent-tint: #eef2ff;
		--cal-free: #065f46;
		--cal-free-ink: #ffffff;
		--cal-free-tint: #d1fae5;
		--cal-seg-on: #3b31b0;
		--cal-seg-off: #ccd5e2;

		/* Seasonal accents. Strictly a second channel: they colour the break-name
		   chip and the small dot on a named day, and nothing else. The cell fill
		   still carries free / not free, which is the only thing the grid is for.
		   Every -ink is >= 7:1 on its own -bg and every -mark >= 4.5:1 on both cell
		   backgrounds; the lightnesses were searched for those targets in OKLCH. */
		--season-autumn-bg: #ffd5c3;
		--season-autumn-ink: #7a2e00;
		--season-autumn-mark: #bd4e02;
		--season-winter-bg: #bbe7ff;
		--season-winter-ink: #004d6b;
		--season-winter-mark: #0078a3;
		--season-spring-bg: #ffd1e5;
		--season-spring-ink: #772853;
		--season-spring-mark: #b74683;
		--season-summer-bg: #ece0b2;
		--season-summer-ink: #554600;
		--season-summer-mark: #856e00;

		/* Shape. One radius for everything that is not a circle: two tiles that
		   differ by a pixel of rounding is exactly the drift a close reading finds,
		   so there is nothing here to drift. */
		--radius: 2px;

		/* Rhythm. 8pt grid with a 4px half-step, and nothing off it. */
		--space-1: 4px;
		--space-2: 8px;
		--space-3: 12px;
		--space-4: 16px;
		--space-5: 24px;
		--space-6: 32px;
		--header-h: 56px;

		/* Depth. Elevation only: no gradient, no glow, no heavy shadow. */
		--elevation-1: 0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.04);
		--elevation-2: 0 2px 4px rgba(15, 23, 42, 0.08), 0 4px 10px rgba(15, 23, 42, 0.06);

		--motion: 160ms cubic-bezier(0.22, 1, 0.36, 1);

		--z-base: 1;
		--z-sticky: 100;

		min-height: 100vh;
		min-height: 100dvh;
		background: var(--cal-page);
		color: var(--cal-ink);
		hanging-punctuation: first last;
	}

	@media (prefers-color-scheme: dark) {
		.cal-root {
			--cal-page: #0b1120;
			--cal-surface: #151c2c;
			/* Darker than the surface so a recessed tile reads as pushed back. With
			   no borders left, this difference is what separates a day from its
			   card. */
			--cal-recess: #0a0f1c;
			--cal-rule: #2a3550;
			--cal-fill-strong: #3b4767;
			--cal-ink: #f8fafc;
			--cal-ink-2: #cbd5e1;
			--cal-accent: #c7d2fe;
			--cal-accent-ink: #10182c;
			--cal-accent-tint: #1e2740;
			--cal-free: #34d399;
			--cal-free-ink: #052e1f;
			--cal-free-tint: #14342c;
			--cal-seg-on: #818cf8;
			--cal-seg-off: #334155;

			/* Same hues, re-searched against the dark surfaces. A soft autumn orange
			   that reads beautifully on white is exactly the one that fails here, so
			   none of these are the light values dimmed. */
			--season-autumn-bg: #3c1c0d;
			--season-autumn-ink: #f29971;
			--season-autumn-mark: #d46225;
			--season-winter-bg: #002a3c;
			--season-winter-ink: #52bcee;
			--season-winter-mark: #008ebf;
			--season-spring-bg: #391a2a;
			--season-spring-ink: #ed93be;
			--season-spring-mark: #ce5b97;
			--season-summer-bg: #2e2500;
			--season-summer-ink: #c8af4e;
			--season-summer-mark: #9b8200;

			--elevation-1: 0 1px 2px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.4);
			--elevation-2: 0 2px 4px rgba(0, 0, 0, 0.55), 0 4px 10px rgba(0, 0, 0, 0.45);
		}
	}

	/* One mapping for both surfaces that use a season: the chip in the detail
	   panel and the dot on the day cell. */
	:global(.cal-root [data-season="autumn"]) {
		--season-bg: var(--season-autumn-bg);
		--season-ink: var(--season-autumn-ink);
		--season-mark: var(--season-autumn-mark);
	}

	:global(.cal-root [data-season="winter"]) {
		--season-bg: var(--season-winter-bg);
		--season-ink: var(--season-winter-ink);
		--season-mark: var(--season-winter-mark);
	}

	:global(.cal-root [data-season="spring"]) {
		--season-bg: var(--season-spring-bg);
		--season-ink: var(--season-spring-ink);
		--season-mark: var(--season-spring-mark);
	}

	:global(.cal-root [data-season="summer"]) {
		--season-bg: var(--season-summer-bg);
		--season-ink: var(--season-summer-ink);
		--season-mark: var(--season-summer-mark);
	}

	:global(.cal-root *) {
		box-sizing: border-box;
	}

	/* Every focus ring on the page is this one outline, and it hugs whatever
	   radius it lands on. */
	:global(.cal-root :focus-visible) {
		outline: 2px solid var(--cal-accent);
		outline-offset: 2px;
	}

	/* Header: one hairline rule under it, no box around it. */
	.cal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		height: var(--header-h);
		padding-inline: var(--space-4);
		background: var(--cal-surface);
		border-block-end: 1px solid var(--cal-rule);
		position: sticky;
		inset-block-start: 0;
		z-index: var(--z-sticky);
	}

	.cal-brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--cal-accent);
		min-width: 0;
	}

	.cal-brand h1 {
		font-size: 1rem;
		font-weight: 600;
		color: var(--cal-ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cal-back,
	.cal-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--cal-ink-2);
		text-decoration: none;
		font-size: 0.85rem;
		font-weight: 500;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius);
		white-space: nowrap;
		transition:
			background var(--motion),
			color var(--motion);
	}

	.cal-back:hover,
	.cal-link:hover {
		background: var(--cal-recess);
		color: var(--cal-ink);
	}

	.cal-header-right {
		display: flex;
		justify-content: end;
	}

	.cal-back,
	.cal-header-right {
		flex: 1 1 0;
		min-width: 0;
	}

	.cal-back {
		justify-content: start;
	}

	.cal-main {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-4);
		padding: var(--space-4) var(--space-3) var(--space-6);
		max-width: 1180px;
		margin: 0 auto;
	}

	@media (min-width: 900px) {
		.cal-main {
			grid-template-columns: minmax(0, 1fr) 320px;
			align-items: start;
			padding: var(--space-5) var(--space-5) var(--space-6);
		}
	}

	.cal-primary {
		min-width: 0;
	}

	.cal-toolbar {
		margin-block-end: var(--space-3);
	}

	.cal-monthline {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.cal-month {
		font-size: 1.15rem;
		font-weight: 600;
		color: var(--cal-ink);
		margin-inline: var(--space-1);
		min-width: 0;
		flex: 1 1 auto;
	}

	@media (min-width: 560px) {
		.cal-month {
			flex: 0 0 auto;
			min-width: 11ch;
		}
	}

	/* Filled tonal controls: the fill separates them from the page, so there is
	   nothing to outline. Both share this block, so they cannot drift apart. */
	.cal-step,
	.cal-today {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		height: 32px;
		border-radius: var(--radius);
		border: none;
		background: var(--cal-recess);
		color: var(--cal-ink-2);
		font-size: 0.82rem;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		transition:
			background var(--motion),
			color var(--motion);
	}

	.cal-step {
		width: 32px;
	}

	.cal-today {
		margin-inline-start: auto;
		padding-inline: var(--space-3);
	}

	.cal-step:hover,
	.cal-today:hover {
		background: var(--cal-accent-tint);
		color: var(--cal-ink);
	}

	.cal-summary {
		margin-block-start: var(--space-2);
		font-size: 0.88rem;
		color: var(--cal-ink-2);
		line-height: 1.45;
		max-width: 62ch;
	}

	.cal-jump {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		margin-block-end: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		border: none;
		background: var(--cal-free-tint);
		color: var(--cal-ink);
		font-size: 0.85rem;
		font-weight: 500;
		font-family: inherit;
		text-align: start;
		cursor: pointer;
		transition: box-shadow var(--motion);
	}

	.cal-jump:hover {
		box-shadow: var(--elevation-1);
	}

	.cal-jump > span:first-of-type {
		min-width: 0;
		flex: 1 1 auto;
	}

	.cal-jump-go {
		flex: 0 0 auto;
		font-weight: 600;
		color: var(--cal-accent);
		text-decoration: underline;
	}

	/* The grid is a card. The days inside it are recessed tiles, so the grid
	   reads without a single box being drawn. */
	.cal-grid-wrap {
		background: var(--cal-surface);
		border-radius: var(--radius);
		padding: var(--space-2);
		box-shadow: var(--elevation-1);
	}

	.cal-weekdays,
	.cal-week {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: var(--space-1);
	}

	.cal-weekday {
		text-align: center;
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--cal-ink-2);
		padding-block-end: var(--space-2);
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
		gap: var(--space-1);
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
		min-height: 56px;
		padding: var(--space-1);
		padding-block-end: var(--space-2);
		border-radius: var(--radius);
		border: none;
		background: var(--cal-recess);
		color: var(--cal-ink);
		font-family: inherit;
		cursor: pointer;
		text-align: start;
		transition:
			background var(--motion),
			box-shadow var(--motion),
			outline-color var(--motion);
	}

	@media (min-width: 700px) {
		.cal-day {
			min-height: 88px;
			padding: var(--space-2);
			padding-block-end: var(--space-3);
		}
	}

	.cal-day:hover {
		background: var(--cal-accent-tint);
		box-shadow: var(--elevation-1);
	}

	/* Padding days belong to a neighbouring month: they drop back to the card. */
	.cal-day.is-out {
		background: transparent;
	}

	.cal-day.is-out:hover {
		background: var(--cal-accent-tint);
	}

	/* The one M3 outlined tile on the page, spent on today. Inset so it can never
	   collide with the selection ring on the neighbouring cell. */
	.cal-day.is-today {
		outline: 1px solid var(--cal-accent);
		outline-offset: -1px;
	}

	/* The strongest state on the page. Nothing else is a solid saturated block. */
	.cal-day.is-allfree {
		background: var(--cal-free);
		color: var(--cal-free-ink);
	}

	.cal-day.is-allfree:hover {
		background: var(--cal-free);
	}

	.cal-day.is-allfree.is-out {
		background: var(--cal-free-tint);
		color: var(--cal-ink);
	}

	.cal-day.is-allfree.is-out:hover {
		background: var(--cal-free-tint);
	}

	/* Inset, for the same reason as today: 42 tiles four pixels apart cannot each
	   carry a ring that sits outside them. */
	.cal-day.is-selected,
	.cal-day:focus-visible {
		outline: 2px solid var(--cal-accent);
		outline-offset: -2px;
		z-index: var(--z-base);
	}

	.cal-dayhead {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 0;
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

	/* The whole seasonal budget on the grid: one dot saying "this day has a name",
	   tinted by which season the name belongs to. It sits beside the date, well
	   clear of the fill and the notches, because those two are the data. */
	.cal-daymark {
		width: 6px;
		height: 6px;
		flex: 0 0 auto;
		border-radius: 50%;
		background: var(--season-mark);
	}

	/* On the solid all-free fill the season would have to fight the strongest
	   state on the page, so it stands down and the dot borrows the fill's own ink,
	   exactly as the notch strip already does. */
	.cal-day.is-allfree .cal-daymark {
		background: var(--cal-free-ink);
	}

	.cal-day.is-allfree.is-out .cal-daymark {
		background: var(--cal-free);
	}

	.cal-daycount {
		position: absolute;
		inset-block-start: var(--space-1);
		inset-inline-end: var(--space-1);
		font-size: 0.7rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--cal-ink-2);
		line-height: 1;
	}

	@media (min-width: 700px) {
		.cal-daycount {
			inset-block-start: var(--space-2);
			inset-inline-end: var(--space-2);
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
		margin-block-start: auto;
		padding-block-start: var(--space-2);
	}

	.cal-seg {
		flex: 1 1 0;
		min-width: 0;
		height: 4px;
		border-radius: var(--radius);
		background: var(--cal-seg-off);
	}

	@media (min-width: 700px) {
		.cal-seg {
			height: 6px;
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
		gap: var(--space-2) var(--space-4);
		margin-block-start: var(--space-3);
		font-size: 0.8rem;
		color: var(--cal-ink-2);
	}

	.cal-legend-item,
	.cal-legend-note {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 0;
	}

	.cal-swatch {
		width: 12px;
		height: 12px;
		border-radius: var(--radius);
		flex: 0 0 auto;
	}

	.cal-swatch.is-allfree {
		background: var(--cal-free);
	}

	/* A day tile in miniature: the recessed fill plus one notch. The inset shadow
	   draws the notch, it is not a border in disguise. */
	.cal-swatch.is-some {
		background: var(--cal-recess);
		box-shadow: inset 0 -3px 0 var(--cal-seg-on);
	}

	.cal-side {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: 0;
	}

	/* The detail panel plus the editor run taller than the grid, which on a wide
	   screen left most of the left-hand column empty. Pinning the column and
	   letting it scroll on its own keeps the page as tall as the calendar. */
	@media (min-width: 900px) {
		.cal-side {
			position: sticky;
			inset-block-start: calc(var(--header-h) + var(--space-2));
			max-height: calc(100dvh - var(--header-h) - var(--space-4));
			overflow-y: auto;
			scrollbar-gutter: stable;
		}
	}

	:global(.cal-panel) {
		background: var(--cal-surface);
		border-radius: var(--radius);
		padding: var(--space-4);
		box-shadow: var(--elevation-1);
		min-width: 0;
	}

	.cal-onboard {
		text-align: start;
		color: var(--cal-accent);
	}

	.cal-onboard h3 {
		margin-block-start: var(--space-2);
		font-size: 1rem;
		font-weight: 600;
		color: var(--cal-ink);
	}

	.cal-onboard p {
		margin-block-start: var(--space-2);
		font-size: 0.86rem;
		line-height: 1.55;
		color: var(--cal-ink-2);
	}

	.cal-nearmiss h3 {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--cal-ink);
	}

	.cal-nearmiss-range {
		margin-block-start: var(--space-2);
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--cal-ink);
	}

	.cal-nearmiss-body {
		margin-block-start: var(--space-1);
		font-size: 0.85rem;
		line-height: 1.5;
		color: var(--cal-ink-2);
	}

	.cal-textbtn {
		margin-block-start: var(--space-2);
		padding: 0;
		border: none;
		background: none;
		color: var(--cal-accent);
		font-size: 0.85rem;
		font-weight: 600;
		font-family: inherit;
		text-decoration: underline;
		cursor: pointer;
		border-radius: var(--radius);
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.cal-root *) {
			transition: none !important;
		}
	}
</style>
