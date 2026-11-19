<script lang="ts">
	import { clock, day, plural } from "#lib/format.ts";
	import type { PublicSafety } from "#lib/server/alerts.ts";
	import type { Chaos } from "#lib/server/news.ts";
	import type { Gap, Gauge } from "#lib/server/weekly.ts";

	import Meter from "./Meter.svelte";

	/** The dial bank: the noise meter and the risk meter side by side, then the two sub-dials. */
	let {
		chaos,
		risk,
		ics,
		safety,
		gap,
		kevCheckedAt,
		icsCheckedAt,
	}: {
		chaos: Chaos;
		risk: Gauge;
		ics: Gauge;
		safety: PublicSafety;
		gap: Gap | undefined;
		kevCheckedAt: string | undefined;
		icsCheckedAt: string | undefined;
	} = $props();

	const GAPS: Record<Gap, string> = {
		"noise-ahead": "The noise is running ahead of the risk.",
		"risk-ahead": "The risk is running ahead of the noise.",
		level: "The noise and the risk are about level.",
	};
	const count = (gauge: Gauge) => (gauge.kind === "stale" ? 0 : gauge.value);
</script>

<section class="bank" aria-labelledby="bank-title">
	<h1 id="bank-title">
		{#if gap}
			{GAPS[gap]}
		{:else if chaos.gauge.kind === "short" && risk.kind === "reading"}
			No headline yet. The chaos-o-meter has {chaos.gauge.have} of the {chaos.gauge.need} days it needs.
		{:else}
			No headline yet. One of the two meters has no reading.
		{/if}
	</h1>
	<p class="how">
		The chaos-o-meter reads how loud the news is. The cyber risk factor reads what is being
		exploited. The headline is set by code from where the two needles sit.
	</p>

	<div class="pair">
		<Meter
			id="chaos-title"
			title="Chaos-o-meter"
			gauge={chaos.gauge}
			labels={{ quiet: "Quiet day", busy: "Loud day", heavy: "Very loud day" }}
			than="Louder than"
			periods="days"
			stale={chaos.checkedAt
				? "The news count has not been refreshed in the last five hours."
				: "The first news count has not finished yet."}
			summary={chaos.day
				? `${plural(count(chaos.gauge), "headline", "headlines")}${chaos.capped ? " or more" : ""} named ransomware, a cyberattack or a data breach on ${day(chaos.day)}, the last full day.${chaos.today ? ` Today so far: ${String(chaos.today.articles)}${chaos.today.capped ? " or more" : ""}.` : ""}`
				: undefined}
			sources={[{ label: "Google News search feeds", href: "https://news.google.com/" }]}
			checkedAt={chaos.checkedAt}
		>
			{#snippet method()}
				The needle counts how many of the settled days among the 28 before the last full day had
				strictly fewer headlines containing "ransomware", "cyberattack" or "data breach" in Google
				News. It needs 14 such days before the day it reads. They are our own counts, each taken
				within two days of its day: Google's index thins with age, so a day counted late would read
				too quiet and make today look loud. A day is a US Pacific day, as Google dates it, and its
				count is final three hours after it ends. A story found under two words counts once. Each
				word's results stop at 100, the feed's limit, so a very loud day reads as "or more", and a
				past day at the limit never counts as quieter. This is coverage volume: it measures
				attention, never risk, and it moves no other dial.
			{/snippet}
			{#if chaos.headlines.length > 0}
				<div class="list">
					<h3>Reported, unconfirmed</h3>
					<ul>
						{#each chaos.headlines as headline (headline.url)}
							<li>
								<a href={headline.url} rel="external noreferrer">{headline.title}</a>
								<span>{headline.outlet}, {clock(headline.published)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</Meter>

		<Meter
			id="risk-title"
			title="Cyber risk factor"
			gauge={risk}
			labels={{ quiet: "Quiet week", busy: "Busy week", heavy: "Heavy week" }}
			than="Busier than"
			periods="weeks"
			stale="No check of CISA's list has succeeded today."
			summary={`CISA added ${plural(count(risk), "exploited vulnerability", "exploited vulnerabilities")} to its list in the last 7 days.`}
			sources={[
				{
					label: "CISA KEV catalog",
					href: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
				},
			]}
			checkedAt={kevCheckedAt}
		>
			{#snippet method()}
				The needle counts how many of the 52 weeks before this one had strictly fewer additions to
				CISA's Known Exploited Vulnerabilities list than the last 7 days. Today is still running, so
				the count can rise before midnight US Eastern. The top tenth of the scale is a heavy week.
				Every entry carries the day CISA added it, so the list is its own history. Nothing here is
				weighted by how widely the affected software is used.
			{/snippet}
		</Meter>
	</div>

	<div class="pair">
		<Meter
			id="ics-title"
			title="Critical infrastructure"
			sub
			gauge={ics}
			labels={{ quiet: "Quiet week", busy: "Busy week", heavy: "Heavy week" }}
			than="Busier than"
			periods="weeks"
			stale="CISA's advisory index has not been read in the last 13 hours."
			summary={`CISA published ${plural(count(ics), "industrial control system advisory", "industrial control system advisories")} in the last 7 days.`}
			sources={[
				{
					label: "CISA ICS advisories (CSAF)",
					href: "https://www.cisa.gov/news-events/cybersecurity-advisories?f%5B0%5D=advisory_type%3A95",
				},
			]}
			checkedAt={icsCheckedAt}
		>
			{#snippet method()}
				The needle counts how many of the 52 weeks before this one had strictly fewer new CISA
				advisories for industrial control systems and medical devices: the equipment that runs
				power, water, transport, factories and hospitals. An advisory is counted on the day CISA
				first published it, read from its number, so an update is not a new advisory. This counts
				published flaws, not attacks, and it is one dial for all sectors.
			{/snippet}
		</Meter>

		<Meter
			id="safety-title"
			title="Public safety"
			sub
			gauge={safety.gauge}
			labels={{ quiet: "Quiet week", busy: "Busy week", heavy: "Heavy week" }}
			than="Busier than"
			periods="weeks"
			stale="The alert feed has not been read in the last three hours."
			summary={`US authorities sent ${plural(count(safety.gauge), "non-weather emergency alert", "non-weather emergency alerts")} in the last 7 days.`}
			sources={[
				{ label: "National Weather Service alerts", href: "https://www.weather.gov/alerts" },
			]}
			checkedAt={safety.checkedAt}
		>
			{#snippet method()}
				With alerts this rare, a single one can read as a heavy week. This counts first alerts, not
				updates, for 911 telephone outages, civil danger and civil emergency messages, evacuations,
				hazardous materials, law enforcement, local area emergencies, nuclear plant and radiological
				warnings and shelter in place orders, as US authorities broadcast them through the National
				Weather Service. The service keeps seven days, so the baseline is our own record, and the
				needle appears once it holds 13 weeks. Hospital hacks have no primary feed here and are not
				counted.
			{/snippet}
			{#if safety.recent.length > 0}
				<div class="list">
					<h3>Sent in the last 7 days</h3>
					<ul>
						{#each safety.recent.slice(0, 5) as alert (alert.id)}
							<li>
								{alert.event}: {alert.area}
								<span>{clock(alert.sent)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</Meter>
	</div>
</section>

<style>
	.bank {
		display: grid;
		gap: 1px;
	}
	h1 {
		margin: 0.5rem 0 0;
		font-size: clamp(1.75rem, 1.3rem + 2.2vw, 3rem);
		font-weight: 300;
		line-height: 1.1;
		text-wrap: balance;
	}
	.how {
		max-inline-size: 70ch;
		margin: 0.5rem 0 1.5rem;
		color: var(--color-muted);
	}
	.pair {
		display: grid;
		gap: 1px;
	}
	@media (min-width: 60rem) {
		.pair {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.list h3 {
		margin: 0.5rem 0 0;
		font-size: 0.8125rem;
		font-weight: 500;
	}
	.list ul {
		display: grid;
		margin: 0.25rem 0 0;
		padding: 0;
		list-style: none;
	}
	.list li {
		padding-block: 0.5rem;
		border-block-start: 1px solid var(--color-rule);
		font-size: 0.9375rem;
	}
	.list span {
		display: block;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
</style>
