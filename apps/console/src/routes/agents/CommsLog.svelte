<script lang="ts">
	import type { CommsEvent } from "$lib/api/types";
	import AgentPresence from "$lib/components/AgentPresence.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import { Effect } from "effect";
	import SegmentedControl from "$lib/components/SegmentedControl.svelte";
	import { getCommsLog } from "./comms.remote";

	type TypeFilter = "all" | "task-card" | "rpc" | "mail";
	let type = $state<TypeFilter>("all");
	let agent = $state("");
	let task = $state("");
	let items = $state<CommsEvent[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let failed = $state(false);
	let requestVersion = 0;
	const taskInvalid = $derived(task.trim() !== "" && !/^[1-9]\d*$/.test(task.trim()));
	function selectType(value: TypeFilter): void { type = value; }

	function kind(item: CommsEvent): Exclude<TypeFilter, "all"> {
		return item.method === "comms.card" ? "task-card" : item.method === "comms.rpc" ? "rpc" : "mail";
	}

	function clock(iso: string): string {
		return new Intl.DateTimeFormat(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).format(new Date(iso));
	}

	async function read(cursor: string | null = null, append = false) {
		const version = ++requestVersion;
		if (taskInvalid) {
			items = [];
			nextCursor = null;
			loading = false;
			loadingMore = false;
			failed = false;
			return;
		}
		if (append) loadingMore = true;
		else loading = true;
		failed = false;
		const parsedTask = /^\d+$/.test(task.trim()) ? Number(task.trim()) : null;
		try {
			const result = await Effect.runPromise(getCommsLog({
				type: type === "all" ? null : type,
				agent: agent.trim() || null,
				taskId: parsedTask && parsedTask > 0 ? parsedTask : null,
				cursor,
			}));
			if (version !== requestVersion) return;
			items = append ? [...items, ...result.items] : result.items;
			nextCursor = result.next_cursor;
		} catch {
			if (version === requestVersion) failed = true;
		} finally {
			if (version === requestVersion) {
				loading = false;
				loadingMore = false;
			}
		}
	}

	$effect(() => {
		const activeFilters = [type, agent, task] as const;
		const timer = setTimeout(() => {
			void activeFilters;
			void read();
		}, 180);
		return () => { clearTimeout(timer); };
	});
</script>

<section class="comms-log" aria-labelledby="correspondence-title">
	<header>
		<div class="title">
			<Icon name="stamp" size={16} />
			<div>
				<h2 id="correspondence-title">Correspondence</h2>
				<p>Persisted inter-agent traffic</p>
			</div>
		</div>
		<span class="truth" class:error={failed} role="status" aria-live="polite">
			{failed ? "Query unavailable" : loading ? "Reading the archive" : `${String(items.length)} ${items.length === 1 ? "letter" : "letters"}`}
		</span>
	</header>

	<div class="filters" aria-label="Correspondence filters">
		<SegmentedControl
			class="type-filter"
			label="Message type"
			value={type}
			options={[
				{ value: "all", label: "All" },
				{ value: "task-card", label: "task-card" },
				{ value: "rpc", label: "rpc" },
				{ value: "mail", label: "mail" },
			]}
			onchange={selectType}
		/>
		<label>
			<Icon name="search" size={13} />
			<input bind:value={agent} aria-label="Filter by agent" placeholder="Agent" autocomplete="off" />
		</label>
		<label class="task-filter">
			<Icon name="search" size={13} />
			<input bind:value={task} aria-label="Filter by task ID" aria-invalid={taskInvalid} placeholder="Task ID" inputmode="numeric" pattern="[0-9]*" autocomplete="off" />
		</label>
	</div>

	<div class="table-wrap" aria-busy={loading}>
		<table>
			<thead><tr><th>Time</th><th>Route</th><th>Type</th><th>About</th><th>Body</th></tr></thead>
			<tbody>
				{#if loading}
					{#each Array.from({ length: 6 }, (_, index) => index) as index (index)}
						<tr class="skeleton-row" aria-hidden="true"><td><span></span></td><td><span></span></td><td><span></span></td><td><span></span></td><td><span></span></td></tr>
					{/each}
				{:else if taskInvalid}
					<tr><td colspan="5" class="state"><Icon name="circle-alert" size={15} />Task ID must be a positive integer.</td></tr>
				{:else if failed}
					<tr><td colspan="5" class="state"><Icon name="circle-help" size={15} />Query failed. Nothing rendered, nothing pretended. <button type="button" onclick={() => void read()}>Try again</button></td></tr>
				{:else if items.length === 0}
					<tr><td colspan="5" class="state"><Icon name="mailbox" size={15} />No letters in this window.</td></tr>
				{:else}
					{#each items as item (item.id)}
						<tr>
							<td data-label="Time"><time datetime={item.ts}>{clock(item.ts)}</time></td>
							<td data-label="Route"><div class="route"><AgentPresence handle={item.sender} label="from" /><span aria-hidden="true">→</span><AgentPresence handle={item.recipient} label="to" /></div></td>
							<td data-label="Type"><span class="type-chip">{kind(item)}</span></td>
							<td data-label="About">
								<div class="about">
									{#if item.task_id}<a href={`/work?task=${String(item.task_id)}`}>task {item.task_id}</a>{/if}
									{#if item.about}<span>{item.about}</span>{/if}
									{#if item.in_reply_to}<Icon name="reply" size={12} /><span class="sr-only">Reply</span>{/if}
								</div>
							</td>
							<td data-label="Body"><span class="body" title={item.body_preview ?? undefined}>{item.body_preview ?? "—"}</span></td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
		{#if nextCursor && !loading && !failed}
			<div class="more"><button type="button" disabled={loadingMore} onclick={() => void read(nextCursor, true)}>{loadingMore ? "Loading…" : "Load earlier letters"}</button></div>
		{/if}
	</div>
</section>

<style>
	.comms-log { margin-top: var(--s-4); height: 320px; min-height: 320px; background: var(--s1); border-radius: var(--r-xs); overflow: hidden; animation: open 160ms cubic-bezier(.22,1,.36,1); }
	header { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--rule); }
	.title { display: flex; align-items: center; gap: var(--s-2); min-width: 0; }
	.title :global(svg) { color: var(--jade); flex: none; }
	h2 { margin: 0; font: 400 1.125rem/1.15 var(--sign); letter-spacing: -0.012em; }
	.title p { margin: 2px 0 0; color: var(--text-3); font: 500 0.6875rem var(--mono); }
	.truth { color: var(--jade-text); font: 500 0.6875rem var(--mono); white-space: nowrap; }
	.truth.error { color: var(--warn-text); }
	.filters { height: 40px; display: flex; align-items: center; gap: var(--s-2); padding: var(--s-1) var(--s-3); border-bottom: 1px solid var(--rule); overflow-x: auto; }
	.filters label { display: inline-flex; align-items: center; gap: var(--s-1); width: 136px; min-width: 112px; height: 32px; padding: 0 var(--s-2); border-radius: var(--r-sm); background: var(--s2); color: var(--text-3); }
	.filters .task-filter { width: 104px; min-width: 96px; }
	.filters label:focus-within { box-shadow: 0 0 0 2px var(--petal); }
	.filters input { min-width: 0; width: 100%; border: 0; outline: 0; background: transparent; color: var(--text); font: 400 0.75rem var(--sans); }
	.table-wrap { height: 231px; overflow: auto; }
	table { width: 100%; border-collapse: collapse; table-layout: fixed; }
	th { position: sticky; top: 0; z-index: 1; height: 24px; padding: 0 var(--s-2); background: var(--s1); color: var(--text-3); text-align: left; font: 500 0.6875rem var(--mono); border-bottom: 1px solid var(--rule); }
	th:nth-child(1) { width: 64px; } th:nth-child(2) { width: 260px; } th:nth-child(3) { width: 88px; } th:nth-child(4) { width: 224px; }
	td { height: 32px; padding: var(--s-1) var(--s-2); border-bottom: 1px solid var(--rule); color: var(--text-2); font-size: 0.75rem; vertical-align: middle; }
	time { color: var(--text-3); font: 500 0.6875rem var(--mono); font-feature-settings: "tnum" 1; }
	.route, .about { display: flex; align-items: center; gap: var(--s-1); min-width: 0; white-space: nowrap; overflow: hidden; }
	.route > span { color: var(--text-3); }
	.type-chip { display: inline-flex; align-items: center; min-height: 20px; padding: 0 var(--s-1); border-radius: var(--r-xs); background: var(--petal-soft); color: var(--petal-text); font: 500 0.6875rem var(--mono); }
	.about a { color: var(--petal-text); font: 500 0.6875rem var(--mono); }
	.about span { overflow: hidden; text-overflow: ellipsis; color: var(--text-3); font: 500 0.6875rem var(--mono); }
	.about :global(svg) { color: var(--jade-text); flex: none; }
	.body { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
	.state { height: 128px; text-align: center; color: var(--text-2); }
	.state :global(svg) { display: inline; margin-inline-end: var(--s-1); color: var(--warn-dot); vertical-align: -2px; }
	.state button, .more button { min-height: 32px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--petal-text); font: 500 0.75rem var(--sans); }
	.state button:hover, .more button:hover { background: var(--petal-soft); }
	.state button:focus-visible, .more button:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	.skeleton-row span { display: block; height: 10px; max-width: 90%; border-radius: var(--r-xs); background: var(--s3); animation: pulse 1.2s ease-in-out infinite alternate; }
	.more { display: flex; justify-content: center; padding: var(--s-1); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
	@keyframes open { from { opacity: .65; transform: translateY(-4px); } }
	@keyframes pulse { to { opacity: .45; } }
	@media (max-width: 767px) {
		.comms-log { height: min(560px, calc(100dvh - 112px)); min-height: 400px; }
		header { padding-inline: var(--s-2); }
		.filters { height: auto; min-height: 80px; align-items: stretch; flex-wrap: wrap; overflow: visible; padding-inline: var(--s-2); }
		.filters :global(.type-filter) { width: 100%; overflow-x: auto; }
		.filters label { flex: 1; width: auto; }
		.table-wrap { height: calc(100% - 145px); }
		table, tbody { display: block; }
		thead { display: none; }
		tr { display: grid; grid-template-columns: 56px 1fr auto; gap: var(--s-1) var(--s-2); padding: var(--s-2); border-bottom: 1px solid var(--rule); }
		td { display: block; height: auto; min-width: 0; padding: 0; border: 0; }
		td:nth-child(2) { grid-column: 2; grid-row: 1; } td:nth-child(3) { grid-column: 3; grid-row: 1; } td:nth-child(4), td:nth-child(5) { grid-column: 2 / -1; }
		.skeleton-row { display: grid; }
		.state { grid-column: 1 / -1; padding: var(--s-5) var(--s-2); }
	}
	@media (prefers-reduced-motion: reduce) { .comms-log { animation: none; } .skeleton-row span { animation: none; } }
</style>
