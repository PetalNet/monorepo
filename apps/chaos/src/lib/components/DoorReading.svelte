<script lang="ts">
	import { day, plural, weekday } from "$lib/format";
	import type { Reading } from "$lib/server/door";

	import SourceLine from "./SourceLine.svelte";

	let {
		reading,
		date,
		checkedAt,
	}: {
		reading: Reading;
		/** Today on the door clock. */
		date: string;
		checkedAt: string | undefined;
	} = $props();

	const door = $derived(reading.door);
	const today = $derived(door.state === "today");
	const dates = $derived(
		door.from === door.to ? day(door.from) : `${day(door.from)} to ${day(door.to, "short")}`,
	);
	const KEV = "its Known Exploited Vulnerabilities list";
	const CATALOG = "https://www.cisa.gov/known-exploited-vulnerabilities-catalog";
</script>

<section class="reading" aria-labelledby="door-title">
	<header>
		<h1 id="door-title">{door.id === "pre" ? "Pre-season door" : door.label}</h1>
		<p class="when">{today ? `Today, ${weekday(date)}` : dates}</p>
	</header>

	<p class="lede">
		{#if today && !reading.current}
			No current data. The last successful check of CISA's list was not today, so this door says
			nothing about today yet.
		{:else if today && reading.added === 0}
			CISA has added nothing to {KEV} today, as of the last check.
		{:else if today}
			CISA added {plural(reading.added, "vulnerability", "vulnerabilities")} to {KEV} today.
		{:else if !reading.current}
			No check has succeeded since this door closed, so its count may be short.
		{:else if reading.added === 0}
			CISA added nothing to {KEV} on these dates.
		{:else}
			CISA added {plural(reading.added, "vulnerability", "vulnerabilities")} to {KEV} on these dates.
		{/if}
		{#if today && door.from !== door.to && door.added !== undefined}
			This door has counted {door.added.toLocaleString("en-US")} since {day(door.from)}.
		{/if}
	</p>

	{#if reading.item && reading.shownDate}
		{@const item = reading.item}
		<article>
			<p class="rank">
				{#if today && reading.added === 0}
					Last addition on record, {day(reading.shownDate)}
				{:else if reading.shownCount === 1}
					The one addition, {day(reading.shownDate)}
				{:else}
					Worst of {reading.shownCount}, added {day(reading.shownDate)}
				{/if}
			</p>
			<h2>{item.name}</h2>
			<p class="what">{item.description}</p>
			<dl>
				<div>
					<dt>Cause</dt>
					<dd class="cause">{reading.cause}</dd>
				</div>
				<div>
					<dt>CVE</dt>
					<dd class="mono">{item.cveId}</dd>
				</div>
				<div>
					<dt>Product</dt>
					<dd>{item.vendor} {item.product}</dd>
				</div>
				<div>
					<dt>Ransomware use</dt>
					<dd>{item.ransomware ? "Known to CISA" : "Not known to CISA"}</dd>
				</div>
				<div>
					<dt>US agencies must fix by</dt>
					<dd>{day(item.dueDate)}</dd>
				</div>
			</dl>
			<SourceLine
				sources={[
					{ label: "CISA KEV entry", href: `${CATALOG}?field_cve=${item.cveId}` },
					{ label: "NVD record", href: `https://nvd.nist.gov/vuln/detail/${item.cveId}` },
				]}
				{checkedAt}
			/>
		</article>
		<p class="rule">
			How the worst is picked: the list carries no severity score, so entries CISA ties to
			ransomware come first, then the earliest fix deadline. "Attack" means CISA lists it as
			exploited in the wild.
		</p>
	{:else}
		<SourceLine sources={[{ label: "CISA KEV catalog", href: CATALOG }]} {checkedAt} />
	{/if}
</section>

<style>
	.reading {
		padding: 1.5rem 1rem 2rem;
		background: var(--color-base-100);
		animation: settle 500ms var(--ease-out-expo);
	}
	@keyframes settle {
		from {
			opacity: 0.4;
			clip-path: inset(0 0 100% 0);
		}
		to {
			opacity: 1;
			clip-path: inset(0);
		}
	}
	@media (min-width: 60rem) {
		.reading {
			padding: 2.5rem 3rem 3rem;
		}
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 1rem;
	}
	h1 {
		margin: 0;
		font-size: clamp(2rem, 1.4rem + 2.6vw, 3.25rem);
		font-weight: 300;
		line-height: 1.05;
		text-wrap: balance;
	}
	.when {
		margin: 0;
		font-size: 1.125rem;
		color: var(--color-muted);
	}
	.lede {
		max-inline-size: 62ch;
		margin: 1rem 0 0;
		font-size: 1.125rem;
		text-wrap: pretty;
	}
	article {
		margin-block-start: 2rem;
		padding-block-start: 1.5rem;
		border-block-start: 1px solid var(--color-rule);
	}
	.rank {
		margin: 0;
		color: var(--color-muted);
	}
	h2 {
		max-inline-size: 30ch;
		margin: 0.25rem 0 0;
		font-size: clamp(1.375rem, 1.2rem + 0.9vw, 1.75rem);
		font-weight: 500;
		line-height: 1.2;
		text-wrap: balance;
	}
	.what {
		max-inline-size: 68ch;
		margin: 0.75rem 0 0;
		text-wrap: pretty;
	}
	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		column-gap: 2rem;
		margin: 1.5rem 0 1rem;
		border-block-end: 1px solid var(--color-rule);
	}
	dl div {
		padding-block: 0.75rem;
		border-block-start: 1px solid var(--color-rule);
	}
	dt {
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	dd {
		margin: 0;
	}
	.mono {
		font-family: var(--font-mono), monospace;
		font-size: 0.9375rem;
	}
	.cause {
		font-weight: 500;
		color: var(--color-primary);
		text-transform: capitalize;
	}
	.rule {
		max-inline-size: 62ch;
		margin: 1.5rem 0 0;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
</style>
