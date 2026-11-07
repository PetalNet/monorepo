<script lang="ts">
	import { goto } from "$app/navigation";
	import { resolve } from "$app/paths";
	import type { HistoryEntry } from "$lib/api";
	import { isTapeWidth } from "$lib/doc";
	import { editor } from "$lib/editor/editor.svelte";
	import Banner from "$lib/ui/Banner.svelte";
	import Button from "$lib/ui/Button.svelte";
	import { api, errorText, historyPage } from "$lib/ui/client";
	import JobRow from "$lib/ui/JobRow.svelte";
	import { jobs } from "$lib/ui/jobs.svelte";
	import RasterThumb from "$lib/ui/RasterThumb.svelte";
	import Sheet from "$lib/ui/Sheet.svelte";
	import Skeleton from "$lib/ui/Skeleton.svelte";
	import { tapeMmActual } from "$lib/ui/tape";
	import { formatMm, plainError, relativeTime } from "$lib/ui/words";
	import { PenLine, RotateCcw } from "@lucide/svelte";

	const PAGE = 30;

	let entries = $state<HistoryEntry[] | null>(null);
	let failure = $state<string | null>(null);
	let more = $state(false);
	let loadingMore = $state(false);
	let reprinting = $state<HistoryEntry | null>(null);
	let confirm = $state(false);
	let sending = $state(false);
	let reprintError = $state<string | null>(null);
	let reprintJob = $state<string | null>(null);

	async function load(before?: string): Promise<void> {
		try {
			const page = await api.history(PAGE, before);

			entries = before === undefined ? page : [...(entries ?? []), ...page];
			more = page.length === PAGE;
			failure = null;
		} catch (error) {
			failure = errorText(error, "History failed to load");
		}
	}

	void load();

	// A finished job from this tab shows up in the list without a manual refresh.
	$effect(() => {
		const finished = jobs.tracked.filter(
			(entry) => entry.job.status === "done" || entry.job.status === "failed",
		).length;

		if (finished > 0) {
			void load();
		}
	});

	async function reprint(): Promise<void> {
		if (!reprinting) {
			return;
		}

		sending = true;
		reprintError = null;

		try {
			const job = await api.reprint(reprinting.id);

			jobs.follow(
				job,
				{
					doc: reprinting.doc,
					rows: reprinting.rows,
					copies: reprinting.copies,
					cut: reprinting.cut,
					chain: reprinting.chain,
					title: reprinting.title,
				},
				false,
			);

			reprintJob = job.id;
		} catch (error) {
			reprintError = plainError(errorText(error, "Reprint failed"));
		} finally {
			sending = false;
		}
	}

	async function openInEditor(entry: HistoryEntry): Promise<void> {
		editor.load(entry.doc, null, { ...(entry.rows[0] ?? {}) });
		await goto(resolve("/"));
	}

	const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
	const tracked = $derived(reprintJob === null ? null : (jobs.find(reprintJob) ?? null));
</script>

<div class="page">
	<header>
		<h1>History</h1>
		<p class="sub">Every print and dry run, newest first.</p>
	</header>

	{#if failure}
		<Banner tone="danger">
			{failure}
			{#snippet action()}<Button size="sm" onclick={() => load()}>Retry</Button>{/snippet}
		</Banner>
	{/if}

	{#if entries === null && !failure}
		<ul class="list">
			{#each { length: 6 }, index (index)}
				<li class="entry">
					<Skeleton width="160px" height="40px" />
					<div class="body"><Skeleton width="40%" /><Skeleton width="25%" height="12px" /></div>
				</li>
			{/each}
		</ul>
	{:else if entries?.length === 0}
		<div class="empty">
			<p>
				Nothing printed yet. Prints and dry runs land here with a copy of their design, ready to
				reprint.
			</p>
			<Button variant="primary" onclick={() => goto(resolve("/"))}>Open the editor</Button>
		</div>
	{:else if entries}
		<ul class="list">
			{#each entries as entry (entry.id)}
				<li class="entry">
					<div class="thumb">
						<RasterThumb src={historyPage(entry.id)} alt="Printed raster of {entry.title}" />
					</div>
					<div class="body">
						<div class="title">
							<strong>{entry.title}</strong>
							{#if entry.dryRun}<span class="tag">Dry run</span>{/if}
							{#if entry.status === "failed"}<span class="tag danger">Failed</span>{/if}
						</div>
						<span class="meta num">
							<time datetime={entry.createdAt} title={day.format(new Date(entry.createdAt))}
								>{relativeTime(entry.createdAt)}</time
							>
							<span class="sep">·</span>
							{entry.pages}
							{entry.pages === 1 ? "label" : "labels"}{entry.copies > 1
								? ` × ${String(entry.copies)}`
								: ""}
							<span class="sep">·</span>
							<span class="nowrap"
								>{formatMm(entry.lengthMm)}&nbsp;<span class="unit">mm</span></span
							>
							<span class="sep">·</span>
							<span class="nowrap"
								>{isTapeWidth(entry.tapeMm) ? tapeMmActual(entry.tapeMm) : entry.tapeMm}&nbsp;<span
									class="unit">mm tape</span
								></span
							>
						</span>
						{#if entry.error}<span class="error">{plainError(entry.error)}</span>{/if}
					</div>
					<div class="actions">
						<Button size="sm" variant="ghost" onclick={() => openInEditor(entry)}
							><PenLine size={14} /> Edit</Button
						>
						<Button
							size="sm"
							onclick={() => {
								reprinting = entry;
								reprintJob = null;
								reprintError = null;
								confirm = true;
							}}><RotateCcw size={14} /> Reprint</Button
						>
					</div>
				</li>
			{/each}
		</ul>
		{#if more}
			<div class="more">
				<Button
					busy={loadingMore}
					onclick={async () => {
						loadingMore = true;
						await load(entries?.at(-1)?.id);
						loadingMore = false;
					}}>Show older</Button
				>
			</div>
		{/if}
	{/if}
</div>

<Sheet
	bind:open={confirm}
	title="Reprint"
	width="460px"
	onclose={() => {
		if (tracked && tracked.job.status !== "done") {
			jobs.show(tracked.job.id);
		}
	}}
>
	{#if reprinting}
		<div class="confirm">
			<div class="thumb large">
				<RasterThumb
					src={historyPage(reprinting.id)}
					alt="Printed raster of {reprinting.title}"
					height={72}
				/>
			</div>
			{#if tracked}
				<JobRow entry={tracked} dismissible={false} />
			{:else}
				<p class="num">
					Print <strong>{reprinting.title}</strong> again: {reprinting.pages}
					{reprinting.pages === 1 ? "label" : "labels"}{reprinting.copies > 1
						? ` × ${String(reprinting.copies)}`
						: ""},
					<strong>{formatMm(reprinting.lengthMm)} mm</strong> of tape{reprinting.dryRun
						? ", as a dry run"
						: ""}.
				</p>
			{/if}
			{#if reprintError}<Banner tone="danger">{reprintError}</Banner>{/if}
		</div>
	{/if}
	{#snippet footer()}
		{#if tracked}
			<Button variant="primary" onclick={() => (confirm = false)}>Done</Button>
		{:else}
			<Button variant="ghost" onclick={() => (confirm = false)}>Cancel</Button>
			<Button variant="primary" busy={sending} onclick={reprint}
				><RotateCcw size={16} /> Reprint</Button
			>
		{/if}
	{/snippet}
</Sheet>

<style>
	.page {
		display: grid;
		gap: 20px;
		max-width: 960px;
		margin-inline: auto;
		padding: 24px 24px 96px;
	}

	h1 {
		font-size: 22px;
		font-weight: 500;
		line-height: 1.2;
	}

	.sub {
		color: var(--ink-2);
	}

	.list {
		display: grid;
		margin: 0;
		padding: 0;
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
		list-style: none;
	}

	.entry {
		display: grid;
		grid-template-columns: 200px minmax(0, 1fr) auto;
		align-items: center;
		gap: 16px;
		padding: 14px 16px;
	}

	.entry + .entry {
		box-shadow: 0 -1px 0 var(--rule);
	}

	.thumb {
		display: grid;
		place-items: center;
		height: 72px;
		--dimension-bg: var(--ground);
		padding: 6px;
		border-radius: var(--r);
		background: var(--ground);
		overflow: hidden;
	}

	.thumb.large {
		height: 128px;
		padding: 16px;
	}

	.body {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.title {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	strong {
		overflow: hidden;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tag {
		flex: none;
		padding: 1px 6px;
		border-radius: var(--r);
		background: var(--sunken);
		color: var(--ink-2);
		font-size: 11px;
	}

	.tag.danger {
		background: var(--danger-soft);
		color: var(--danger);
	}

	.meta {
		color: var(--ink-2);
		font-size: 12px;
	}

	.sep,
	.unit {
		color: var(--ink-3);
	}

	.nowrap {
		white-space: nowrap;
	}

	.error {
		color: var(--danger);
		font-size: 12px;
	}

	.actions {
		display: flex;
		gap: 4px;
	}

	.more {
		display: flex;
		justify-content: center;
	}

	.empty {
		display: grid;
		justify-items: center;
		gap: 16px;
		padding: 48px 24px;
		border-radius: var(--r);
		background: var(--sunken);
		color: var(--ink-2);
		text-align: center;
	}

	.empty p {
		max-width: 44ch;
	}

	.confirm {
		display: grid;
		gap: 16px;
	}

	@media (max-width: 760px) {
		.page {
			padding: 16px 16px 96px;
		}

		.entry {
			grid-template-columns: 1fr auto;
			gap: 10px 12px;
		}

		.thumb {
			grid-column: 1 / -1;
		}
	}
</style>
