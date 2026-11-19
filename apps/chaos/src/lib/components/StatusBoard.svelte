<script lang="ts">
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleDashed from "@lucide/svelte/icons/circle-dashed";
	import OctagonX from "@lucide/svelte/icons/octagon-x";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import Wrench from "@lucide/svelte/icons/wrench";

	import { clock, hour, plural } from "#lib/format.ts";
	import type { Board, ServiceRow, Verdict } from "#lib/server/status/board.ts";

	let { board }: { board: Board } = $props();

	const LAMPS = { ok: CircleCheck, degraded: TriangleAlert, outage: OctagonX, maintenance: Wrench };
	const VERDICTS: Record<Verdict, string> = {
		agree: "Agree",
		differ: "Differ",
		partial: "Partial",
		retrying: "Rechecking",
		unknown: "No reading",
	};

	const count = (verdict: Verdict) => board.rows.filter((row) => row.verdict === verdict).length;

	/** The two readings in one sentence, for the rows where they do not simply match. */
	function gap(row: ServiceRow): string | undefined {
		if (row.verdict === "differ") {
			return row.probe?.reachable
				? "The status page reports a full outage. Our probe still gets an answer."
				: `The status page reports no trouble. Our probe has failed ${String(row.probe?.fails)} times in a row.`;
		}

		return row.verdict === "retrying" ? "One probe failed. The next round decides." : undefined;
	}
</script>

<section class="board" aria-labelledby="board-title">
	<header>
		<h2 id="board-title">Status pages against our own probes</h2>
		<p class="tally">
			{plural(board.rows.length, "service", "services")}: {count("differ")} differ, {count(
				"partial",
			)}
			partial, {count("agree")} agree{count("unknown") + count("retrying") > 0
				? `, ${String(count("unknown") + count("retrying"))} without a full reading`
				: ""}.
		</p>
	</header>

	{#if board.blind}
		<p class="blind">
			<TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
			A third or more of our probes are failing at once. The fault is probably our own network, so no
			failed probe is held against a service.
		</p>
	{/if}

	<ul>
		{#each board.rows as row (row.id)}
			{@const Lamp = row.claim ? LAMPS[row.claim.level] : CircleDashed}
			{@const Seen = !row.probe ? CircleDashed : row.probe.reachable ? CircleCheck : OctagonX}
			<li class={row.verdict}>
				<h3>
					<a href={row.page} rel="external noreferrer">{row.name}</a>
					<span class="verdict">{VERDICTS[row.verdict]}</span>
				</h3>
				<dl>
					<div>
						<dt>They say</dt>
						<dd class={row.claim?.level ?? "none"}>
							<Lamp size={16} strokeWidth={1.75} aria-hidden="true" />
							<span>
								{row.claim?.text ?? "No current reading"}
								{#if row.claim}<time datetime={row.claim.checkedAt}
										>{hour(row.claim.checkedAt)}</time
									>{/if}
							</span>
						</dd>
					</div>
					<div>
						<dt>We see</dt>
						<dd class={!row.probe ? "none" : row.probe.reachable ? "ok" : "outage"}>
							<Seen size={16} strokeWidth={1.75} aria-hidden="true" />
							<span>
								{#if !row.probe}
									No current reading
								{:else if row.probe.reachable}
									{row.target} answered in {row.probe.detail}
								{:else}
									{row.target}: {row.probe.detail}
								{/if}
								{#if row.probe}<time datetime={row.probe.checkedAt}
										>{hour(row.probe.checkedAt)}</time
									>{/if}
							</span>
						</dd>
					</div>
				</dl>
				{#if gap(row)}<p class="gap">{gap(row)}</p>{/if}
			</li>
		{/each}
	</ul>

	<p class="method">
		How it reads: "They say" is the company's own status page, in its own words. "We see" is one
		small request from one place, our lab, every ten minutes. Any answer below HTTP 500 counts as
		reachable, so a probe proves the front door answers and nothing deeper. Two failed probes in a
		row count as failing. "Partial" means the page reports partial trouble or maintenance while our
		one probe still gets an answer, which is how a partial incident looks from outside. AWS and
		Google Cloud incidents cover some regions or products, so they are always read as partial. When
		a third of our probes fail at once we blame our own network. Times are US Eastern.
	</p>
	<p class="source">
		Sources: each service's status page, linked from its name, and our own probes.
		{#if board.checkedAt}
			Oldest reading on show <time datetime={board.checkedAt}>{clock(board.checkedAt)}</time>
		{:else}
			Not checked yet
		{/if}
	</p>
</section>

<style>
	.board {
		padding: 1.5rem 1rem;
		background: var(--color-base-100);
	}
	@media (min-width: 60rem) {
		.board {
			padding: 2rem 3rem;
		}
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 2rem;
	}
	h2 {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 500;
	}
	.tally {
		margin: 0;
		color: var(--color-muted);
	}
	.blind {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		max-inline-size: 70ch;
		margin: 1rem 0 0;
		color: var(--color-warning);
	}
	.blind :global(svg) {
		flex: none;
		margin-block-start: 0.25rem;
	}
	ul {
		display: grid;
		column-gap: 3rem;
		margin: 1rem 0 0;
		padding: 0;
		list-style: none;
	}
	@media (min-width: 60rem) {
		ul {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	li {
		padding-block: 0.75rem;
		border-block-start: 1px solid var(--color-rule);
	}
	h3 {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin: 0;
		font-size: 1rem;
		font-weight: 500;
	}
	.verdict {
		font-size: 0.8125rem;
		font-weight: 400;
		color: var(--color-muted);
	}
	.differ .verdict {
		font-weight: 500;
		color: var(--color-primary);
	}
	/* A row where the page and the probe differ keeps a slow beat until they agree again. */
	.differ .verdict::before {
		content: "";
		display: inline-block;
		inline-size: 0.5rem;
		block-size: 0.5rem;
		margin-inline-end: 0.5rem;
		border-radius: 50%;
		background: currentcolor;
		animation: beat 2s ease-in-out infinite;
	}
	@keyframes beat {
		50% {
			opacity: 0.25;
		}
	}
	dl {
		display: grid;
		gap: 0.25rem 1.5rem;
		margin: 0.25rem 0 0;
	}
	@media (min-width: 30rem) {
		dl {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	dt {
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	dd {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		margin: 0;
		font-size: 0.9375rem;
		overflow-wrap: anywhere;
	}
	dd :global(svg) {
		flex: none;
		margin-block-start: 0.25rem;
	}
	dd.ok :global(svg) {
		color: var(--color-success);
	}
	dd.degraded :global(svg),
	dd.maintenance :global(svg) {
		color: var(--color-warning);
	}
	dd.outage :global(svg) {
		color: var(--color-error);
	}
	dd time {
		margin-inline-start: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-muted);
		white-space: nowrap;
	}
	dd.none {
		color: var(--color-muted);
	}
	.gap {
		margin: 0.5rem 0 0;
		font-size: 0.9375rem;
	}
	.method,
	.source {
		max-inline-size: 70ch;
		margin: 1rem 0 0;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	.method {
		padding-block-start: 1rem;
		border-block-start: 1px solid var(--color-rule);
		max-inline-size: none;
	}
</style>
