<script lang="ts">
	import { day } from "$lib/format";
	import type { Gauge, Level } from "$lib/server/weekly";
	import type { Snippet } from "svelte";

	import Dial from "./Dial.svelte";
	import SourceLine from "./SourceLine.svelte";

	/** One dial with its reading in words, its trace, its method and its source. */
	let {
		id,
		title,
		gauge,
		labels,
		than,
		periods,
		stale,
		summary,
		sources,
		checkedAt,
		sub = false,
		method,
		children,
	}: {
		id: string;
		title: string;
		gauge: Gauge;
		/** The words for each level, for example "Quiet week". */
		labels: Record<Level, string>;
		/** "Busier than" or "Louder than": how the rank is put in words. */
		than: string;
		/** "weeks" or "days": what the baseline is counted in. */
		periods: string;
		/** Why there is no reading, when there is no current data. */
		stale: string;
		/** The count behind the reading, in a sentence. Shown whenever there is a count. */
		summary?: string;
		sources: readonly { label: string; href: string }[];
		checkedAt: string | undefined;
		/** A sub-dial is drawn smaller. */
		sub?: boolean;
		method: Snippet;
		/** What sits under the reading: a list of the items behind it, for example. */
		children?: Snippet;
	} = $props();

	const peak = $derived(
		gauge.kind === "reading" ? Math.max(1, ...gauge.series.map((period) => period.value)) : 1,
	);
</script>

<section class="meter" class:sub aria-labelledby={id}>
	<h2 {id}>{title}</h2>
	<div class="dial">
		<Dial
			fraction={gauge.kind === "reading" ? gauge.quieter / gauge.of : undefined}
			steps={gauge.of}
			majors={[0, 1, 2, 3, 4].map((quarter) => Math.round((gauge.of * quarter) / 4))}
			hotFrom={0.9}
		/>
	</div>
	{#if gauge.kind === "reading"}
		<p class="value">
			<strong class:hot={gauge.level === "heavy"}>{labels[gauge.level]}</strong>
			{than}
			{gauge.quieter} of the {gauge.of}
			{periods} before
		</p>
	{:else if gauge.kind === "short"}
		<p class="value">
			<strong>Not enough history yet</strong>
			{gauge.have} of the {gauge.need} days a reading needs so far
		</p>
	{:else}
		<p class="value">
			<strong>No reading</strong>
			{stale}
		</p>
	{/if}

	{#if summary && gauge.kind !== "stale"}<p class="count">{summary}</p>{/if}

	{#if gauge.kind === "reading"}
		<div class="trace" aria-hidden="true">
			{#each gauge.series as period, index (period.end)}
				<i
					class:now={index === gauge.series.length - 1}
					style:--h="{(period.value / peak) * 100}%"
					title="{day(period.end, 'short')}: {period.value}"
				></i>
			{/each}
		</div>
		<p class="axis" aria-hidden="true">
			<span>{day(gauge.series[0]?.end ?? "", "short")}</span>
			<span>Median {gauge.median}, peak {peak}</span>
			<span>{day(gauge.series.at(-1)?.end ?? "", "short")}</span>
		</p>
	{/if}

	{@render children?.()}

	<details>
		<summary>How it reads</summary>
		<p>{@render method()}</p>
	</details>
	<SourceLine {sources} {checkedAt} />
</section>

<style>
	.meter {
		display: grid;
		align-content: start;
		gap: 0.75rem;
		padding: 1.5rem 1rem;
		background: var(--color-base-100);
	}
	@media (min-width: 60rem) {
		.meter {
			padding: 2rem 3rem;
		}
		.meter.sub {
			padding: 1.5rem 3rem;
		}
	}
	h2 {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 500;
	}
	.dial {
		inline-size: min(100%, 22rem);
		margin-block-start: 0.5rem;
	}
	.sub .dial {
		inline-size: min(100%, 14rem);
	}
	.value {
		margin: 0;
		color: var(--color-muted);
	}
	.value strong {
		display: block;
		font-size: 1.75rem;
		font-weight: 300;
		line-height: 1.2;
		color: var(--color-base-content);
	}
	.sub .value strong {
		font-size: 1.375rem;
	}
	.value .hot {
		color: var(--color-primary);
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
		block-size: 3.5rem;
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
		gap: 1rem;
		margin: -0.5rem 0 0;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	details {
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	summary {
		inline-size: max-content;
		padding-block: 0.25rem;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: var(--color-rule-strong);
		text-underline-offset: 0.2em;
	}
	details p {
		max-inline-size: 62ch;
		margin: 0.25rem 0 0;
	}
	details[open] p {
		animation: unfold 300ms var(--ease-out-expo);
	}
	@keyframes unfold {
		from {
			opacity: 0;
			clip-path: inset(0 0 100% 0);
		}
	}
</style>
