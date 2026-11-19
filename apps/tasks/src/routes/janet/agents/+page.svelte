<script>
	import { invalidateAll } from "$app/navigation";
	import { onMount } from "svelte";

	let { data } = $props();
	let now = $state(Date.now());
	let refreshError = $state(false);
	let refreshing = $state(false);
	let snapshot = $derived(data.snapshot);
	let runs = $derived(
		(snapshot?.runs ?? [])
			.filter(
				(run) =>
					run.status === "running" ||
					time(run.endedAt || run.startedAt) >= now - 48 * 60 * 60 * 1000,
			)
			.slice()
			.sort(
				(a, b) =>
					Number(b.status === "running") - Number(a.status === "running") ||
					time(b.startedAt) - time(a.startedAt),
			),
	);

	function time(value) {
		if (!value) {
			return 0;
		}

		const parsed = typeof value === "number" ? value : Date.parse(value);

		return Number.isFinite(parsed) ? parsed : 0;
	}

	function date(value) {
		const stamp = time(value);

		return stamp
			? new Date(stamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
			: "Not recorded";
	}

	function duration(run) {
		const start = time(run.startedAt);

		if (!start) {
			return "Not recorded";
		}

		const end = time(run.endedAt) || (run.status === "running" ? now : 0);

		if (!end) {
			return "Not recorded";
		}

		const seconds = Math.max(0, Math.floor((end - start) / 1000));

		if (seconds < 60) {
			return `${seconds}s`;
		}

		if (seconds < 3600) {
			return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		}

		return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
	}

	function safeLink(value) {
		try {
			const url = new URL(typeof value === "string" ? value : value?.url);

			return url.protocol === "https:" &&
				url.hostname === "github.com" &&
				/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
				? url.href
				: null;
		} catch {
			return null;
		}
	}

	async function refresh() {
		if (refreshing) {
			return;
		}

		refreshing = true;

		try {
			// The snapshot load must be invalidated on each poll.
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			await invalidateAll();
			refreshError = false;
		} catch {
			refreshError = true;
		} finally {
			refreshing = false;
			now = Date.now();
		}
	}

	onMount(() => {
		const timer = setInterval(refresh, 20_000);

		return () => clearInterval(timer);
	});
</script>

<svelte:head><title>Agents | Janet</title></svelte:head>

<div class="agents">
	<header class="heading">
		<div>
			<a class="back" href="/janet/home">Janet</a>
			<h1>Agents</h1>
			<p>Routed work from the last 48 hours.</p>
		</div>
		<button onclick={refresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</button
		>
	</header>

	{#if refreshError}
		<p class="notice" role="alert">
			Could not refresh. Showing the last available snapshot. Try refresh again.
		</p>
	{/if}
	{#if !snapshot}
		<section class="empty" aria-live="polite">
			<h2>Agent activity unavailable</h2>
			<p>No snapshot is available yet. Try refreshing later.</p>
		</section>
	{:else}
		<p class="updated">Snapshot updated {date(snapshot.updatedAt)} · Refreshes every 20 seconds</p>
		{#if runs.length === 0}
			<section class="empty">
				<h2>All caught up.</h2>
				<p>No agents running or recorded in the last 48 hours.</p>
			</section>
		{:else}
			<div class="run-list">
				{#each runs as run (run.id)}
					<details class="run">
						<summary>
							<span class="run-main"
								><strong>{run.name || "Unnamed agent"}</strong><span class="meta"
									>{run.model || "Model not recorded"} · {run.kind || "Kind not recorded"}{run.tier
										? ` / ${run.tier}`
										: ""}</span
								></span
							>
							<span class="run-end"
								><span class:running={run.status === "running"} class="status"
									>{run.status || "Unknown"}</span
								><span class="meta">{duration(run)} · Details</span></span
							>
						</summary>
						<div class="detail">
							<dl>
								<div>
									<dt>Started</dt>
									<dd>{date(run.startedAt)}</dd>
								</div>
								<div>
									<dt>Duration</dt>
									<dd>{duration(run)}</dd>
								</div>
								<div>
									<dt>Model</dt>
									<dd>{run.model || "Not recorded"}</dd>
								</div>
								<div>
									<dt>Effort</dt>
									<dd>{run.effort || "Not recorded"}</dd>
								</div>
								<div>
									<dt>Plan / pool</dt>
									<dd>{[run.plan, run.pool].filter(Boolean).join(" / ") || "Not recorded"}</dd>
								</div>
								<div>
									<dt>Kind / tier</dt>
									<dd>{[run.kind, run.tier].filter(Boolean).join(" / ") || "Not recorded"}</dd>
								</div>
								<div>
									<dt>Data class</dt>
									<dd>{run.dataClass || "Unknown"}</dd>
								</div>
							</dl>
							<h3>Attempts ({Array.isArray(run.attempts) ? run.attempts.length : 0})</h3>
							{#if Array.isArray(run.attempts) && run.attempts.length}
								<ul class="attempts">
									{#each run.attempts as attempt, i}<li>
											<span>Attempt {attempt.number || i + 1}</span><span
												>{attempt.model || "Model not recorded"} · {attempt.failureClass ||
													"No failure recorded"}</span
											>
										</li>{/each}
								</ul>
							{:else}<p class="muted">No attempts recorded.</p>{/if}
							{#if run.dataClass === "public" || run.dataClass === "sensitive"}
								<h3>Activity</h3>
								{#if run.turns?.length}
									<ol class="turns">
										{#each run.turns as turn}<li>
												<div class="turn-title">
													<strong
														>{turn.name || turn.kind || "Activity"}{turn.status === "failed"
															? " · Failed"
															: ""}</strong
													>{#if turn.at}<time>{date(turn.at)}</time>{/if}
												</div>
												{#if turn.text}<pre>{turn.text}</pre>{/if}{#if turn.result}<details
														class="result"
													>
														<summary>Result</summary>
														<pre>{turn.result}</pre>
													</details>{/if}
											</li>{/each}
									</ol>
								{:else}<p class="muted">
										{run.status === "running"
											? "Activity appears when an attempt finishes."
											: "No activity recorded."}
									</p>{/if}
								<h3>Final output</h3>
								{#if run.output}<pre>{run.output}</pre>{:else}<p class="muted">
										No final output recorded.
									</p>{/if}
								{@const links = (run.links || []).map(safeLink).filter(Boolean)}
								{#if links.length}<h3>Pull requests</h3>
									<ul class="links">
										{#each links as link}<li>
												<a href={link} target="_blank" rel="noopener noreferrer">{link}</a>
											</li>{/each}
									</ul>{/if}
							{:else}
								<p class="notice">
									Metadata only. Activity and output are not shown for this data class.
								</p>
							{/if}
						</div>
					</details>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.agents {
		max-width: 900px;
		margin: 0 auto;
		padding: 40px 32px 80px;
		color: var(--text-1);
	}
	.heading {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 24px;
		margin-bottom: 32px;
	}
	h1 {
		font-size: 28px;
		line-height: 1.2;
		margin: 8px 0;
	}
	.heading p,
	.updated,
	.muted {
		color: var(--text-3);
	}
	.heading p {
		margin: 0;
	}
	.back,
	a {
		color: var(--accent-b);
		overflow-wrap: anywhere;
	}
	button {
		min-height: 44px;
		padding: 0 16px;
		background: var(--surface-2);
		color: var(--text-1);
		border-radius: var(--radius);
		cursor: pointer;
	}
	button:hover {
		background: var(--surface-3);
	}
	button:disabled {
		opacity: 0.65;
		cursor: wait;
	}
	.updated {
		font-size: 13px;
		margin: 0 0 12px;
	}
	.empty,
	.notice {
		padding: 20px;
		background: var(--surface-2);
		border-radius: var(--radius);
	}
	.empty h2 {
		font-size: 18px;
		margin: 0 0 8px;
	}
	.empty p,
	.notice {
		margin: 0 0 16px;
	}
	.run-list {
		border-top: 1px solid var(--border-sub);
	}
	.run {
		border-bottom: 1px solid var(--border-sub);
	}
	.run > summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-height: 76px;
		padding: 12px 8px;
		cursor: pointer;
		list-style: none;
	}
	.run > summary::-webkit-details-marker {
		display: none;
	}
	.run > summary:hover {
		background: var(--surface-2);
	}
	.run-main,
	.run-end {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.run-main strong {
		overflow-wrap: anywhere;
	}
	.run-end {
		align-items: end;
		text-align: right;
		flex-shrink: 0;
	}
	.meta,
	time {
		color: var(--text-3);
		font-size: 13px;
	}
	.status {
		font-size: 13px;
		font-weight: 600;
		text-transform: capitalize;
	}
	.status.running {
		color: var(--accent-b);
	}
	.detail {
		padding: 8px 8px 24px;
	}
	dl {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 16px 24px;
		margin: 0 0 24px;
	}
	dt {
		color: var(--text-3);
		font-size: 13px;
	}
	dd {
		margin: 4px 0 0;
		overflow-wrap: anywhere;
	}
	h3 {
		font-size: 15px;
		margin: 24px 0 8px;
	}
	.attempts,
	.turns,
	.links {
		padding: 0;
		margin: 0;
		list-style: none;
	}
	.attempts li,
	.turns li {
		padding: 12px 0;
		border-top: 1px solid var(--border-sub);
	}
	.attempts li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 4px 16px;
	}
	.turn-title {
		display: flex;
		justify-content: space-between;
		gap: 16px;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font: inherit;
		margin: 8px 0;
	}
	.result {
		background: var(--surface-2);
		padding: 8px 12px;
		margin-top: 8px;
	}
	.result summary {
		cursor: pointer;
		min-height: 28px;
	}
	.links li {
		margin: 8px 0;
	}
	@media (max-width: 600px) {
		.agents {
			padding: 24px 16px 64px;
		}
		.heading {
			align-items: start;
		}
		dl {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
