<script>
	import Icon from "$lib/Icon.svelte";
	import { projectName, whoColor as whoColorBase } from "$lib/people.js";
	let { data } = $props();

	const projName = $derived(projectName(data.projects));

	// ── time helpers (mirror +page.svelte) ──────────────────────────────────
	function relShort(ts) {
		if (!ts) {
			return "";
		}

		const s = Math.round((Date.now() - new Date(ts.replace(" ", "T") + "Z").getTime()) / 1000);

		if (s < 60) {
			return s + "s";
		}

		if (s < 3600) {
			return Math.round(s / 60) + "m";
		}

		if (s < 86400) {
			return Math.round(s / 3600) + "h";
		}

		if (s < 604800) {
			return Math.round(s / 86400) + "d";
		}

		return Math.round(s / 604800) + "w";
	}
	// lease age: server hands us lease_age_s (>0 = expired). Render "12m over" / "in 4m".
	function leaseLabel(s) {
		if (s == null) {
			return "no lease";
		}

		const a = Math.abs(s);
		const mag =
			a < 60
				? a + "s"
				: a < 3600
					? Math.round(a / 60) + "m"
					: a < 86400
						? Math.round(a / 3600) + "h"
						: Math.round(a / 86400) + "d";

		return s >= 0 ? `${mag} over` : `in ${mag}`;
	}

	// ── per-person colours (single-sourced from $lib/people; this page's falsy-handle
	//    fallback is '#94a3b8') ───────────────────────────────────────────────
	const whoColor = (h) => whoColorBase(h, "#94a3b8");
	const isAgent = (h) => data.config.people[String(h).toLowerCase()]?.kind === "agent";

	const g = $derived(data.counts.global);
	const cFor = (agent) =>
		data.counts.byAgent[agent] ?? { ready: 0, doing: 0, blocked: 0, review: 0, closedToday: 0 };
</script>

<svelte:head><title>fleet · board</title></svelte:head>

{#snippet avatar(who, sz = 20)}
	{@const pc = whoColor(who)}
	<span
		class="avatar"
		style="width:{sz}px;height:{sz}px;font-size:{Math.round(
			sz * 0.45,
		)}px;color:{pc};border-color:{pc};background:{isAgent(who)
			? 'transparent'
			: pc + '22'};border-style:{isAgent(who) ? 'dashed' : 'solid'}"
		>{(who || "?").charAt(0).toLowerCase()}</span
	>
{/snippet}

{#snippet laneHead(title, count, accent, icon)}
	<div class="lane-head {accent ? 'lane-' + accent : ''}">
		{#if icon}<span class="lane-ic"><Icon name={icon} size={14} /></span>{/if}
		<h2>{title}</h2>
		<span class="lane-count">{count}</span>
	</div>
{/snippet}

<!-- a compact task line for the secondary lanes (review / ready) -->
{#snippet miniRow(t)}
	{@const pc = whoColor(t.assignee)}
	<a
		class="row kind-{t.kind ?? 'task'} st-{t.status ?? 'todo'}"
		href="/task/{t.id}"
		style={t.assignee ? `--pl:${pc}` : ""}
	>
		<span class="row-ic"><Icon name={t.kind ?? "task"} size={16} /></span>
		<span class="row-main">
			<span class="row-title">{t.title}</span>
			<span class="row-sub">
				<span class="tasknum mono">#{t.id}</span>
				{#if projName(t.project_id)}<span class="mono dim">{projName(t.project_id)}</span>{/if}
				{#if t.priority != null}<span class="chip prio prio-{t.priority}">P{t.priority}</span>{/if}
				{#if t.up_next}<span class="chip" style="background:var(--accent-bg);color:var(--accent-b)"
						>up next</span
					>{/if}
			</span>
		</span>
		<span class="row-right">
			{#if t.assignee}{@render avatar(t.assignee, 18)}{/if}
		</span>
	</a>
{/snippet}

<div class="screen board">
	<header class="page-head">
		<div class="ph-row">
			<h1>fleet</h1>
			<span class="ph-tag mono">at a glance</span>
			<span class="ph-spacer"></span>
		</div>
		<p class="ph-sub mono">
			<span class="hl-a">{g.doing} claimed</span> · {g.ready} ready · {g.review} need review · {g.blocked}
			blocked · {g.closedToday} closed today
		</p>
	</header>

	<!-- global running counts -->
	<dl class="statstrip">
		<div>
			<dt>ready</dt>
			<dd>{g.ready}</dd>
		</div>
		<div>
			<dt>claimed</dt>
			<dd class="strong">{g.doing}</dd>
		</div>
		<div>
			<dt>blocked</dt>
			<dd>{g.blocked}</dd>
		</div>
		<div>
			<dt>need review</dt>
			<dd>{g.review}</dd>
		</div>
		<div>
			<dt>closed today</dt>
			<dd>{g.closedToday}</dd>
		</div>
	</dl>

	<div class="lanes">
		<!-- ── per-agent swimlanes ─────────────────────────────────────────── -->
		<section class="lane">
			{@render laneHead("Agent swimlanes", data.lanes.length, "active", "bolt")}
			<div class="swimlanes">
				{#each data.lanes as ln (ln.agent)}
					{@const c = cFor(ln.agent)}
					<div class="swim" style="--c:{whoColor(ln.agent)}" class:has-expired={ln.expired > 0}>
						<div class="swim-head">
							{@render avatar(ln.agent, 24)}
							<span class="swim-name mono">{ln.agent}</span>
							<span class="swim-counts mono dim">
								{ln.tasks.length} claimed · {c.ready} ready · {c.review} review · {c.closedToday} closed
							</span>
							{#if ln.expired}<span class="lease-pill expired">{ln.expired} stale</span>{/if}
							{#if ln.soon}<span class="lease-pill soon">{ln.soon} soon</span>{/if}
						</div>
						<div class="swim-body">
							{#each ln.tasks as t (t.id)}
								<a
									class="row kind-{t.kind ?? 'task'} st-doing"
									href="/task/{t.id}"
									style="--pl:{whoColor(ln.agent)}"
								>
									<span class="row-ic"><Icon name={t.kind ?? "task"} size={16} /></span>
									<span class="row-main">
										<span class="row-title">{t.title}</span>
										<span class="row-sub">
											<span class="tasknum mono">#{t.id}</span>
											{#if projName(t.project_id)}<span class="mono dim"
													>{projName(t.project_id)}</span
												>{/if}
											{#if t.priority != null}<span class="chip prio prio-{t.priority}"
													>P{t.priority}</span
												>{/if}
										</span>
									</span>
									<span class="row-right">
										<span
											class="lease lease-{t.lease_state}"
											title="lease {leaseLabel(t.lease_age_s)}">{leaseLabel(t.lease_age_s)}</span
										>
									</span>
								</a>
							{/each}
						</div>
					</div>
				{:else}
					<p class="lane-empty">No agents are holding a claim right now.</p>
				{/each}
			</div>
		</section>

		<!-- ── needs-human / escalation ────────────────────────────────────── -->
		{#if data.review.length}
			<section class="lane">
				{@render laneHead("Needs a human", data.review.length, "attention", "question")}
				<div class="lane-body">
					{#each data.review as t (t.id)}{@render miniRow(t)}{/each}
				</div>
			</section>
		{/if}

		<!-- ── global ready queue ──────────────────────────────────────────── -->
		<section class="lane">
			{@render laneHead("Ready queue", data.ready.length, "emerald", "bolt")}
			<div class="lane-body">
				{#each data.ready as t (t.id)}{@render miniRow(t)}{:else}<p class="lane-empty">
						Queue is empty — nothing unblocked & unclaimed.
					</p>{/each}
			</div>
		</section>

		<!-- ── stale / reaped ──────────────────────────────────────────────── -->
		{#if data.stale.stale.length}
			<section class="lane">
				{@render laneHead(
					"Stale leases — reap candidates",
					data.stale.stale.length,
					"danger",
					"block",
				)}
				<div class="lane-body">
					{#each data.stale.stale as t (t.id)}
						<a class="row kind-task st-doing reap-row" href="/task/{t.id}">
							<span class="row-ic"><Icon name="block" size={16} /></span>
							<span class="row-main">
								<span class="row-title">{t.title}</span>
								<span class="row-sub">
									<span class="tasknum mono">#{t.id}</span>
									{#if projName(t.project_id)}<span class="mono dim">{projName(t.project_id)}</span
										>{/if}
									{#if t.assignee}<span class="mono dim">{t.assignee}</span>{/if}
								</span>
							</span>
							<span class="row-right"
								><span class="lease lease-expired">{leaseLabel(t.lease_age_s)}</span></span
							>
						</a>
					{/each}
				</div>
			</section>
		{/if}

		<!-- ── recently closed (the why-ledger) ────────────────────────────── -->
		{#if data.stale.closed.length}
			<section class="lane lane-done">
				{@render laneHead("Recently closed", data.stale.closed.length, "", "check")}
				<div class="lane-body">
					{#each data.stale.closed as c (c.at + "-" + c.id)}
						<a class="row st-done kind-task closed-row" href="/task/{c.id}">
							<span class="row-ic shipped-ic"><Icon name="check" size={14} /></span>
							<span class="row-main">
								<span class="row-title">{c.title}</span>
								{#if c.reason}<span class="row-sub close-reason">{c.reason}</span>{/if}
							</span>
							<span class="row-right">
								<span class="tasknum mono">#{c.id}</span>
								{#if c.by}{@render avatar(c.by, 18)}{/if}
								<span class="mono dim age">{relShort(c.at)}</span>
							</span>
						</a>
					{/each}
				</div>
			</section>
		{/if}
	</div>
</div>

<style>
	/* fleet view inherits the standard .board.screen width (780px) — it's a
     single-column stack of cards, not a wide multi-column dashboard. */
	.page-head {
		margin-bottom: 18px;
	}
	.ph-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.ph-spacer {
		flex: 1;
	}
	.statstrip {
		margin-bottom: var(--lane-gap);
	}

	/* swimlanes: a column of per-agent cards */
	.swimlanes {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	/* agent identity is carried by the avatar + name, not a side-stripe (the #1
     AI-UI tell — an operator's /impeccable) */
	.swim {
		background: var(--surface-1);
		border: 1px solid var(--border-sub);
		border-radius: var(--radius-lg);
		padding: 11px 12px;
	}
	.swim.has-expired {
		border-color: var(--danger);
	}
	.swim-head {
		display: flex;
		align-items: center;
		gap: 9px;
		flex-wrap: wrap;
		margin-bottom: 9px;
	}
	.swim-name {
		font-size: 13px;
		color: var(--text-1);
		font-weight: 600;
	}
	.swim-counts {
		font-size: 11px;
	}
	/* flat rows inside the swim card: hairline-separated, hover lifts to surface-2
     (surface-1 would be invisible against the card) */
	.swim-body {
		display: flex;
		flex-direction: column;
		gap: 0;
	}
	.swim-body > :global(* + *) {
		border-top: 1px solid var(--border-sub);
	}
	.swim-body :global(.row:hover) {
		background: var(--surface-2);
	}

	.lease-pill {
		font-family: var(--mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 7px;
		border-radius: 10px;
	}
	.lease-pill.expired {
		background: rgba(220, 38, 38, 0.14);
		color: var(--danger-b);
	}
	.lease-pill.soon {
		background: rgba(234, 179, 8, 0.14);
		color: var(--warn-b);
	}

	/* lease-age tag: red when expired, amber when nearly up, muted otherwise */
	.lease {
		font-family: var(--mono);
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 10px;
		white-space: nowrap;
	}
	.lease-expired {
		background: rgba(220, 38, 38, 0.14);
		color: var(--danger-b);
	}
	.lease-soon {
		background: rgba(234, 179, 8, 0.14);
		color: var(--warn-b);
	}
	.lease-ok {
		color: var(--text-4);
	}
	.lease-none {
		color: var(--text-4);
	}

	.reap-row .row-ic {
		color: var(--danger-b);
	} /* cue via the block icon, not a side-stripe */
	.closed-row {
		text-decoration: none;
	}
	.closed-row .row-title {
		text-decoration: line-through;
		text-decoration-color: var(--text-4);
	}
	.close-reason {
		color: var(--text-3);
		font-size: 12px;
		line-height: 1.35;
	}
	.shipped-ic {
		color: var(--accent);
	}

	.lane-active :global(.lane-head h2) {
		color: var(--accent-b);
	}
	.lane-active :global(.lane-ic) {
		color: var(--accent-b);
	}
	.hl-a {
		color: var(--accent-b);
	}
	.lane-done {
		opacity: 0.9;
	}
	.lane-empty {
		color: var(--text-4);
		font-size: 13px;
		padding: 4px 2px;
	}
	.back {
		cursor: pointer;
	}
</style>
