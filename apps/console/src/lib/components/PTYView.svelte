<script lang="ts">
	import type { HeartbeatItem } from "$lib/api/types";
	import Icon from "./Icon.svelte";
	import StatusPill from "./StatusPill.svelte";

	interface Props {
		session: HeartbeatItem;
		lines: string[];
		state: "connecting" | "live" | "stalled" | "ended" | "error";
		seq: number;
		errorCode?: string | null;
		onretry?: () => void;
	}

	let { session, lines, state, seq, errorCode = null, onretry }: Props = $props();
	const terminalUrl = $derived(
		`/terminal?host=${encodeURIComponent(session.host)}&session=${encodeURIComponent(session.tmux_session ?? "")}&pane=${encodeURIComponent(session.pane_id ?? "")}`,
	);
</script>

<section class="pty" aria-label={`Read-only terminal for ${session.handle ?? session.host}`}>
	<header>
		<code>{session.host} · {session.tmux_session}:{session.pane_id}</code>
		<span class="owner">{session.handle?.slice(0, 1).toUpperCase() ?? "?"} <b>{session.handle ?? "resident"}</b></span>
		<StatusPill tone="idle" label="Read · watch only" />
		<a class="open" href={terminalUrl}><Icon name="square-terminal" size={13} />Open in Terminal</a>
	</header>
	<div class="viewport" role="log" aria-live="off" aria-label="Terminal output">
		{#if state === "live" || state === "stalled"}
			{#each lines as line, __eachKey16 (__eachKey16)}<div>{line}</div>{/each}
		{:else if state === "connecting"}
			<span class="muted">Connecting to {session.host} · {session.tmux_session}:{session.pane_id}</span>
		{:else}
			<div class="failure">
				<span>{state === "ended" ? "Session ended." : `${errorCode ?? "pty_unavailable"} · No terminal output is available.`}</span>
				{#if state === "error" && onretry}<button type="button" onclick={onretry}>Retry</button>{/if}
			</div>
		{/if}
	</div>
	<footer>
		<span class:warn={state === "stalled" || state === "error"}>{state}</span>
		<span>seq {seq}</span>
		<span>scrollback {lines.length} / 10,000</span>
	</footer>
</section>

<style>
	.pty { background: var(--s1); border-radius: var(--r-xs); overflow: hidden; }
	header { display: flex; align-items: center; gap: var(--s-2); min-height: 40px; padding: 0 var(--s-3); border-bottom: 1px solid var(--rule); }
	header code { font: 500 0.75rem var(--mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.owner { display: inline-flex; align-items: center; gap: var(--s-1); padding: var(--s-1) var(--s-2); border-radius: var(--r-pill); background: var(--s2); font-size: 0.75rem; white-space: nowrap; }
	.owner b { font-weight: 500; }
	.open { margin-inline-start: auto; min-height: 32px; padding: 0 var(--s-2); display: inline-flex; align-items: center; gap: var(--s-1); border-radius: var(--r-sm); color: var(--petal-text); font: 500 0.75rem var(--sans); text-decoration: none; white-space: nowrap; }
	.open:hover { background: var(--petal-soft); }
	.open:focus-visible, button:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	.viewport { height: 400px; overflow: auto; padding: var(--s-4); background: var(--bg); color: var(--text); font: 400 0.8125rem/1.45 var(--mono); white-space: pre; }
	.muted { color: var(--text-3); }
	.failure { display: flex; align-items: center; justify-content: center; gap: var(--s-2); min-height: 100%; color: var(--danger-text); white-space: normal; text-align: center; }
	button { min-height: 32px; padding: 0 var(--s-2); border: 0; border-radius: var(--r-sm); background: var(--petal-soft); color: var(--petal-text); font: 500 0.75rem var(--sans); }
	footer { min-height: 32px; display: flex; align-items: center; gap: var(--s-3); padding: 0 var(--s-3); color: var(--text-3); font: 400 0.6875rem var(--mono); }
	footer .warn { color: var(--warn-text); }
	@media (max-width: 767px) {
		header { flex-wrap: wrap; padding-block: var(--s-1); }
		header code { width: 100%; }
		.open { margin-inline-start: 0; }
		.viewport { height: min(58dvh, 420px); }
	}
</style>
