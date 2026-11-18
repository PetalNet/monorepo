<script lang="ts">
	import { day, plural } from "$lib/format";
	import type { Risk } from "$lib/server/risk";

	import Dial from "./Dial.svelte";
	import SourceLine from "./SourceLine.svelte";

	let { risk, checkedAt }: { risk: Risk; checkedAt: string | undefined } = $props();

	const WEEKS = $derived(risk.baselineWeeks);
	const LEVELS = { quiet: "Quiet week", busy: "Busy week", heavy: "Heavy week" } as const;
	const peak = $derived(
		risk.kind === "reading" ? Math.max(1, ...risk.weeks.map((week) => week.added)) : 1,
	);
</script>

<section class="meter" aria-labelledby="risk-title">
	<div class="gauge">
		<h2 id="risk-title">Cyber risk factor</h2>
		<Dial
			fraction={risk.kind === "reading" ? risk.quieterWeeks / WEEKS : undefined}
			steps={WEEKS}
			majorEvery={WEEKS / 4}
			hotFrom={0.9}
		/>
		{#if risk.kind === "reading"}
			<p class="value">
				<strong class:hot={risk.level === "heavy"}>{LEVELS[risk.level]}</strong>
				Busier than {risk.quieterWeeks} of the past {WEEKS} weeks
			</p>
		{:else if risk.kind === "short"}
			<p class="value">
				<strong>Not enough history yet</strong>
				The list covers {plural(risk.days, "day", "days")}. A reading needs {risk.needed} days.
			</p>
		{:else}
			<p class="value">
				<strong>No reading</strong>
				No check of CISA's list has succeeded today.
			</p>
		{/if}
	</div>

	<div class="detail">
		{#if risk.kind === "reading"}
			<p class="count">
				CISA added {plural(risk.week, "exploited vulnerability", "exploited vulnerabilities")} in the
				last 7 days. The median week of the past year had {risk.median}. The heaviest week on the
				chart had {peak}.
			</p>
			<div class="trace" aria-hidden="true">
				{#each risk.weeks as week, index (week.end)}
					<i
						class:now={index === risk.weeks.length - 1}
						style:--h="{(week.added / peak) * 100}%"
						title="Week ending {day(week.end, 'short')}: {week.added}"
					></i>
				{/each}
			</div>
			<p class="axis" aria-hidden="true">
				<span>Week ending {day(risk.weeks[0]?.end ?? "", "short")}</span>
				<span>Peak week {peak}</span>
				<span>This week</span>
			</p>
		{/if}
		<p class="method">
			How it reads: the needle counts how many of the {WEEKS} weeks before this one had strictly fewer
			additions to CISA's exploited list than the last 7 days. Today is still running, so the count can
			rise before midnight. The top tenth of the scale is a heavy week. Every entry carries the day CISA
			added it, so the list is its own history. Nothing here is weighted by how widely the affected software
			is used.
		</p>
		<SourceLine
			sources={[
				{
					label: "CISA KEV catalog",
					href: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
				},
			]}
			{checkedAt}
		/>
	</div>
</section>

<style>
	.meter {
		display: grid;
		gap: 1.5rem 3rem;
		padding: 1.5rem 1rem;
		background: var(--color-base-100);
	}
	@media (min-width: 60rem) {
		.meter {
			grid-template-columns: 20rem minmax(0, 1fr);
			align-items: end;
			padding: 2rem 3rem;
		}
	}
	h2 {
		margin: 0 0 1rem;
		font-size: 1.125rem;
		font-weight: 500;
	}
	.gauge {
		max-inline-size: 22rem;
	}
	.value {
		margin: 0.75rem 0 0;
		color: var(--color-muted);
	}
	.value strong {
		display: block;
		font-size: 1.75rem;
		font-weight: 300;
		line-height: 1.2;
		color: var(--color-base-content);
	}
	.value .hot {
		color: var(--color-primary);
	}
	.detail {
		display: grid;
		gap: 0.75rem;
	}
	.count {
		max-inline-size: 60ch;
		margin: 0;
		text-wrap: pretty;
	}
	.trace {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		block-size: 4.5rem;
		border-block-end: 1px solid var(--color-rule-strong);
	}
	.trace i {
		flex: 1;
		block-size: max(var(--h), 1px);
		background: var(--color-rule-strong);
		transform-origin: bottom;
		animation: rise 900ms var(--ease-out-expo) backwards;
	}
	.trace .now {
		background: var(--color-primary);
	}
	@keyframes rise {
		from {
			transform: scaleY(0);
		}
	}
	.axis {
		display: flex;
		justify-content: space-between;
		margin: -0.5rem 0 0;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	.method {
		max-inline-size: 62ch;
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
</style>
