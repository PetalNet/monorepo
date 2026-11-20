<script lang="ts">
	import { Schema } from "effect";
	import { onMount } from "svelte";

	import { Snapshot } from "#lib/follow-through-schema.ts";

	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();
	let snapshot = $state<Snapshot>();
	let busy = $state(false);
	let problem = $state("");
	let notice = $state("");
	let dropping = $state<number>();
	let reason = $state("");
	let now = $state(Date.now());
	let controller: AbortController | undefined;
	const dueCount = $derived(
		snapshot?.items.filter((item) => item.attention === "pending" && item.due <= now).length ?? 0,
	);

	async function request(endpoint = "promises", payload?: unknown) {
		if (busy) {
			return;
		}

		busy = true;
		problem = "";
		notice = "";
		controller = new AbortController();

		try {
			const response = await fetch(`/api/follow-through/${endpoint}`, {
				method: payload === undefined ? "GET" : "POST",
				headers: payload === undefined ? {} : { "content-type": "application/json" },
				body: payload === undefined ? undefined : JSON.stringify(payload),
				signal: controller.signal,
			});

			if (!response.ok) {
				problem =
					response.status === 403
						? "Your account cannot view or change these promises."
						: "Janet's promise ledger is unavailable. Try refreshing shortly.";

				return;
			}

			snapshot = Schema.decodeUnknownSync(Snapshot)(await response.json());
			now = Date.now();

			if (payload !== undefined) {
				notice = "Saved.";
				dropping = undefined;
				reason = "";
			}
		} catch {
			if (!controller.signal.aborted) {
				problem = "Could not refresh Janet's promises. Check your connection and try again.";
			}
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		void request();

		const timer = setInterval(() => {
			now = Date.now();
			void request();
		}, 30_000);

		return () => {
			clearInterval(timer);
			controller?.abort();
		};
	});

	function date(time: number) {
		return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
			time,
		);
	}
</script>

<svelte:head><title>Janet's promises</title></svelte:head>

<section class="follow-through" aria-busy={busy}>
	<header>
		<a href="/janet/home">Janet</a>
		<div class="heading">
			<h1>Follow-through</h1>
			<button disabled={busy} onclick={() => request()}>Refresh</button>
		</div>
		<p>What Janet owes, when it is due, and what you can stop.</p>
	</header>
	{#if problem}
		<div class="problem" role="alert">
			<p>{problem}</p>
			{#if snapshot}<p>The last view is shown below and may be out of date.</p>{/if}
		</div>
	{/if}
	<p class="notice" role="status">{notice || (busy ? "Updating promises…" : "")}</p>
	{#if data.asks.length > 0}
		<section class="delivery" aria-labelledby="asks-title">
			<div>
				<h2 id="asks-title">Waiting for your answer</h2>
				{#each data.asks as ask (ask.slug)}
					<p><a href={`/gallery/${encodeURIComponent(ask.slug)}`}>{ask.title}</a></p>
				{/each}
			</div>
		</section>
	{/if}
	{#if snapshot}
		<section class="delivery" aria-labelledby="delivery-title">
			<div>
				<h2 id="delivery-title">Reminder delivery</h2>
				<p>{snapshot.paused ? "Paused in the ledger." : "Enabled in the ledger."}</p>
				{#if snapshot.scheduler !== "active"}
					<p class="scheduler">
						{snapshot.scheduler === "paused"
							? "The scheduler is paused. Reminders will wait until it resumes."
							: snapshot.scheduler === "missing"
								? "The scheduler is not installed. Reminders cannot run yet."
								: "Scheduler status is unavailable. Reminder delivery is not verified."}
					</p>
				{/if}
				<p class="meta">
					{snapshot.lastSweep
						? `Last sweep: ${date(Date.parse(snapshot.lastSweep))}`
						: "No sweep has run."}
				</p>
			</div>
			<button disabled={busy} onclick={() => request("delivery", { paused: !snapshot?.paused })}
				>{snapshot.paused ? "Enable reminders" : "Pause reminders"}</button
			>
		</section>
		<div class="list-heading">
			<h2>Open promises and reminders</h2>
			<p>{snapshot.items.length} open{dueCount ? ` · ${dueCount} due` : ""}</p>
		</div>
		{#if snapshot.items.length === 0}
			<p class="empty">No open promises or reminders.</p>
		{:else}
			<ul>
				{#each snapshot.items as item (item.id)}
					<li>
						<div class="item-meta">
							<span class:due={item.attention === "pending" && item.due <= now}
								>{item.attention === "quiet"
									? `Captured ${date(item.created)}`
									: item.attention === "review"
										? "Needs reconciliation"
										: `${item.due <= now ? "Due" : "Scheduled"} ${date(item.due)}`}</span
							><span>{item.kind === "reminder" ? "Reminder" : "Promise"} #{item.id}</span>
						</div>
						<p class="promise">{item.text}</p>
						{#if item.attention === "review"}<p class="meta">
								Needs reconciliation. Automatic reminders have stopped; this is still open.
							</p>{:else if item.attention === "quiet"}<p class="meta">
								Progress acknowledgement. No automatic reminder is scheduled.
							</p>{/if}
						<div class="item-footer">
							{#if item.event && item.room && item.surface === "matrix"}<a
									href={`https://matrix.to/#/${encodeURIComponent(item.room)}/${encodeURIComponent(item.event)}`}
									target="_blank"
									rel="noreferrer">Source conversation</a
								>{:else}<span class="meta">{item.room || item.surface || "Manually scheduled"}</span
								>{/if}
							<div class="actions">
								<button
									disabled={busy}
									aria-label={`Snooze ${item.kind} ${item.id} for one day`}
									onclick={() => request(`promises/${item.id}/snooze`, { hours: 24 })}
									>Snooze a day</button
								><button
									disabled={busy}
									aria-expanded={dropping === item.id}
									onclick={() => {
										dropping = dropping === item.id ? undefined : item.id;
										reason = "";
									}}>Drop</button
								>
							</div>
						</div>
						{#if dropping === item.id}
							<form
								onsubmit={(event) => {
									event.preventDefault();

									if (reason.trim()) {
										void request(`promises/${item.id}/drop`, { reason: reason.trim() });
									}
								}}
							>
								<label for={`reason-${item.id}`}>Why is this no longer needed?</label>
								<input
									id={`reason-${item.id}`}
									bind:value={reason}
									required
									maxlength="500"
									disabled={busy}
								/>
								<div class="actions">
									<button type="submit" disabled={busy || !reason.trim()}>Drop {item.kind}</button
									><button
										type="button"
										disabled={busy}
										onclick={() => {
											dropping = undefined;
											reason = "";
										}}>Cancel</button
									>
								</div>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{:else if !problem}
		<p class="empty">Loading Janet's promises…</p>
	{/if}
</section>

<style>
	.follow-through {
		--control-accent: color-mix(in srgb, var(--accent-b) 70%, var(--text-1));
		max-inline-size: 60rem;
		margin-inline: auto;
		padding: 24px 16px 48px;
		color: var(--text-1);
	}
	header {
		margin-block-end: 24px;
	}
	.heading,
	.list-heading,
	.item-meta,
	.item-footer,
	.actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	h1 {
		font-size: clamp(1.5rem, 3vw, 2rem);
		font-weight: 550;
		line-height: 1.25;
		margin-block: 16px 8px;
	}
	h2 {
		font-size: 1rem;
		font-weight: 600;
		margin: 0;
	}
	p {
		margin-block: 8px 0;
		max-inline-size: 72ch;
	}
	.meta,
	.list-heading p,
	.item-meta {
		color: var(--text-3);
	}
	a {
		color: var(--control-accent);
		text-underline-offset: 0.2em;
	}
	button,
	input {
		font: inherit;
		color: inherit;
		min-block-size: 44px;
		border: 0;
		border-radius: 2px;
		background: var(--surface-3);
		padding: 8px 16px;
		transition:
			background-color 120ms ease-out,
			opacity 120ms ease-out;
	}
	button {
		cursor: pointer;
	}
	button:hover:not(:disabled) {
		background: var(--surface-2);
	}
	button:disabled {
		cursor: default;
		opacity: 0.65;
	}
	button:focus-visible,
	a:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--control-accent);
		outline-offset: 3px;
	}
	.notice {
		min-block-size: 24px;
		margin-block: 0 8px;
		color: var(--text-3);
	}
	.delivery {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 24px;
		flex-wrap: wrap;
		padding: 24px;
		background: var(--surface-2);
		margin-block-end: 32px;
	}
	.due {
		color: var(--control-accent);
	}
	.problem {
		padding: 16px;
		background: var(--surface-2);
		color: var(--text-1);
		margin-block-end: 16px;
	}
	.problem p:first-child {
		margin-block-start: 0;
	}
	ul {
		padding: 0;
		margin-block: 16px 0;
		list-style: none;
	}
	li {
		padding-block: 24px;
		border-block-start: 1px solid var(--border);
	}
	.item-meta,
	.meta {
		font-size: 0.875rem;
	}
	.item-meta {
		font-variant-numeric: tabular-nums;
	}
	.promise {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		line-height: 1.6;
	}
	.item-footer {
		margin-block-start: 16px;
	}
	.item-footer > span {
		overflow-wrap: anywhere;
		min-inline-size: 0;
	}
	.actions {
		justify-content: flex-start;
		gap: 8px;
	}
	form {
		display: grid;
		gap: 8px;
		margin-block-start: 16px;
	}
	input {
		inline-size: 100%;
		box-sizing: border-box;
		caret-color: var(--control-accent);
	}
	.empty {
		padding-block: 32px;
		color: var(--text-3);
	}
	@media (min-width: 48rem) {
		.follow-through {
			padding-inline: 32px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		button,
		input {
			transition: none;
		}
	}
</style>
