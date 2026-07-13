<script lang="ts">
	import { onMount } from "svelte";
	import type { SettlingTask } from "$lib/data/work-settlement";
	import AgentPresence from "./AgentPresence.svelte";
	import Icon from "./Icon.svelte";

	interface Props {
		task: SettlingTask;
		now: number;
		newest?: boolean;
		onsettled?: (task: SettlingTask) => void;
	}

	let { task, now, newest = false, onsettled }: Props = $props();
	let settling = $state(false);
	const remaining = $derived(Date.parse(task.settles_at) - now);
	const elapsedRatio = $derived(
		Math.min(1, Math.max(0, (now - Date.parse(task.updated_at)) / (24 * 60 * 60 * 1_000))),
	);
	const ageGrade = $derived(elapsedRatio >= 0.75 ? "late" : elapsedRatio >= 0.35 ? "middle" : "fresh");
	const countdown = $derived.by(() => {
		if (remaining <= 0) return "settling now";
		if (remaining >= 60 * 60 * 1_000)
			return `settles in ${String(Math.ceil(remaining / (60 * 60 * 1_000)))}h`;
		return `settles in ${String(Math.max(1, Math.ceil(remaining / 60_000)))}m`;
	});
	const agent = $derived(task.claimed_by ?? task.assignee ?? task.created_by ?? null);

	onMount(() => {
		let removeTimer: ReturnType<typeof setTimeout> | undefined;
		const settleTimer = setTimeout(
			() => {
				settling = true;
				removeTimer = setTimeout(() => onsettled?.(task), 240);
			},
			Math.max(0, Date.parse(task.settles_at) - Date.now()),
		);
		return () => {
			clearTimeout(settleTimer);
			if (removeTimer) clearTimeout(removeTimer);
		};
	});
</script>

<a
	class="settle-row {ageGrade}"
	class:settling
	href={`/library?item=task:${String(task.id)}`}
	aria-label={`${task.title}. ${countdown}. Open in Library.`}
>
	<Icon name="circle-check" size={14} />
	<span class="identity">
		<b>{task.title}</b>
		{#if newest}<small>Done. Points posted.</small>{/if}
	</span>
	{#if agent}<AgentPresence handle={agent} label="completed by" />{/if}
	<span class="library-link">open in Library</span>
	<time datetime={task.settles_at}>{countdown}</time>
</a>

<style>
	.settle-row {
		width: 100%;
		min-height: 32px;
		border-top: 1px solid var(--rule);
		color: var(--text);
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr) auto 104px 104px;
		align-items: center;
		gap: var(--s-2);
		text-decoration: none;
		transition:
			background var(--t),
			opacity 240ms var(--ease-standard),
			transform 240ms var(--ease-standard);
	}
	.settle-row:hover { background: var(--s2); }
	.settle-row:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	.identity { min-width: 0; }
	.identity b {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: .8125rem;
		font-weight: 500;
	}
	.identity small { display: block; color: var(--text-3); font-size: .6875rem; }
	.middle :global(svg) { opacity: .78; }
	.late :global(svg) { opacity: .62; }
	.library-link { color: var(--petal-text); font-size: .6875rem; opacity: 0; transition: opacity var(--t); }
	.settle-row:hover .library-link,
	.settle-row:focus-visible .library-link { opacity: 1; }
	time { text-align: right; color: var(--text-2); font: 400 .6875rem var(--mono); }
	.settling { opacity: 0; transform: translateY(2px); pointer-events: none; }
	@media (max-width: 767px) {
		.settle-row { grid-template-columns: 16px minmax(0, 1fr) 88px; }
		.settle-row :global(.agent-presence), .library-link { display: none; }
	}
	@media (prefers-reduced-motion: reduce) {
		.settle-row { transition: background var(--t); }
		.settling { display: none; transform: none; }
		.library-link { transition: none; }
	}
</style>
