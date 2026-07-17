<script lang="ts">
	import { required } from "#format";
	import type { PageProps } from "./$types";
	import { page } from "$app/state";
	import { onMount } from "svelte";
	import {
		connectTerminal,
		terminalAttach,
		terminalDetach,
		terminalInput,
		type TerminalFrame,
	} from "$lib/rpc/browser";
	import { opDef } from "$lib/api/ops";
	import type { HeartbeatItem } from "$lib/api/types";
	import Icon from "$lib/components/Icon.svelte";
	import IconButton from "$lib/components/IconButton.svelte";
	import ModalSurface from "$lib/components/ModalSurface.svelte";
	import OpButton from "$lib/components/OpButton.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";
	import { mockPtyLines, type TermAuditView } from "$lib/data/terminal";
	import { snackbar } from "$lib/stores/snackbar.svelte";

	let { data }: PageProps = $props();
	let filter = $state("");
	let active = $state<HeartbeatItem | null>(null);
	let streamId = $state<string | null>(null);
	let mode = $state<"read" | "write">("read");
	let streamState = $state<"connecting" | "live" | "unavailable">("connecting");
	let selectedAudit = $state<TermAuditView | null>(null);
	let auditDialog = $state<HTMLDialogElement | null>(null);
	let attachDialog = $state<HTMLDialogElement | null>(null);
	let attachOpen = $state(false);
	let contained = $state(false);
	let busy = $state(false);
	let keyboardViewport = $state(false);
	let now = $state(Date.now());
	let terminalLines = $state<string[]>([]);
	let frameSeq = $state(0);
	let stopFrames: (() => void) | null = null;
	let inputQueue = Promise.resolve();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const restart = required(opDef("agent.restart"));
	const stop = required(opDef("agent.stop"));
	const sessions = $derived(data.sessions.filter((session) => `${String(session.tmux_session)} ${String(session.pane_id)} ${session.host} ${String(session.handle)}`.toLowerCase().includes(filter.toLowerCase())));
	const age = (epoch: number) => { const seconds = Math.max(0, Math.round(now / 1000 - epoch)); return seconds < 60 ? `${String(seconds)}s` : seconds < 3600 ? `${String(Math.round(seconds / 60))}m` : seconds < 86400 ? `${String(Math.round(seconds / 3600))}h` : `${String(Math.round(seconds / 86400))}d`; };
	const stale = (epoch: number) => now / 1000 - epoch > 30;
	onMount(() => {
		const updateViewport = () => keyboardViewport = globalThis.innerWidth >= 1024;
		updateViewport();
		const requested = {
			host: page.url.searchParams.get("host"),
			session: page.url.searchParams.get("session"),
			pane: page.url.searchParams.get("pane"),
		};
		const handedOff = data.sessions.find((candidate) => candidate.host === requested.host && candidate.tmux_session === requested.session && candidate.pane_id === requested.pane);
		if (handedOff) watch(handedOff);
		const clock = globalThis.setInterval(() => now = Date.now(), 1000);
		globalThis.addEventListener("resize", updateViewport);
		return () => { stopFrames?.(); globalThis.clearInterval(clock); globalThis.removeEventListener("resize", updateViewport); };
	});
	function frameData(frame: Extract<TerminalFrame, { kind: "snapshot" }>): string {
		const raw = atob(frame.data_b64);
		return decoder.decode(Uint8Array.from(raw, (character) => character.charCodeAt(0)));
	}
	function onTerminalFrame(frame: TerminalFrame) {
		streamId = frame.stream_id;
		frameSeq = frame.seq;
		if (frame.kind === "open") streamState = "live";
		else if (frame.kind === "snapshot") {
			terminalLines = frameData(frame).split("\n");
			streamState = "live";
		} else streamState = "unavailable";
	}

	function watch(session: HeartbeatItem) {
		busy = true; active = session; mode = "read"; streamState = "connecting";
		terminalLines = []; frameSeq = 0; stopFrames?.(); stopFrames = null;
		if (data.isMock) {
			streamId = `mock-${session.session_id}`;
			terminalLines = mockPtyLines;
			streamState = "live";
			busy = false;
			return;
		}
		stopFrames = connectTerminal(
			{ host: session.host, tmux_session: required(session.tmux_session), pane_id: required(session.pane_id), scrollback_lines: 500 },
			(frame) => { onTerminalFrame(frame); busy = false; },
			(error) => { busy = false; streamState = "unavailable"; snackbar.push({ message: `term.watch failed: ${error.message}`, op: "term.watch", tone: "danger" }); },
		);
	}
	async function attachActive() {
		if (!streamId) return;
		busy = true;
		try {
			if (!data.isMock) await terminalAttach(streamId);
			mode = "write";
			attachOpen = false;
			snackbar.push({ message: "term.attach sent", op: "term.attach", tone: "good" });
		} catch (error) {
			snackbar.push({ message: `term.attach failed: ${(error as Error).message}`, op: "term.attach", tone: "danger" });
		} finally { busy = false; }
	}
	async function closeActive() {
		const closingId = streamId;
		if (closingId && !data.isMock) {
			try { await terminalDetach(closingId); }
			catch (error) { snackbar.push({ message: `term.detach failed: ${(error as Error).message}`, op: "term.detach", tone: "danger" }); }
		}
		stopFrames?.(); stopFrames = null; streamId = null; contained = false; active = null;
	}
	function release(event?: KeyboardEvent) { if (!event || (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "q")) { event?.preventDefault(); contained = false; } }
	function terminalKey(event: KeyboardEvent) {
		if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "q") { release(event); return; }
		if (!contained || mode !== "write" || !streamId) return;
		const special: Record<string, string> = { Enter: "\r", Tab: "\t", Backspace: "\x7f", Escape: "\x1b", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D" };
		let value = special[event.key] ?? (event.key.length === 1 ? event.key : "");
		if (event.ctrlKey && event.key.length === 1) value = String.fromCharCode(event.key.toUpperCase().charCodeAt(0) & 31);
		if (!value) return;
		event.preventDefault();
		if (data.isMock) return;
		const id = streamId;
		inputQueue = inputQueue.then(() => terminalInput(id, encoder.encode(value))).catch((error: unknown) => {
			snackbar.push({ message: `term.input failed: ${(error as Error).message}`, op: "term.input", tone: "danger" });
		});
	}
</script>

{#if data.denied}
	<section class="denied"><span><Icon name="square-terminal" size={64} /><Icon name="lock-keyhole" size={28} /></span><h1>Not with your key. Ask an admin.</h1><p>This attempt was logged.</p></section>
{:else if active}
	<header class="sign"><h1 title="the Judge's Chambers">Terminal</h1><span>Chambers. Admins only. The Doorman logs everyone.</span><small>{active.host} · {active.tmux_session}:{active.pane_id}</small><button class="ghost" onclick={closeActive}>Back to sessions</button></header>
	<section class="pty">
			<header><code>{active.host} · {active.tmux_session}:{active.pane_id}</code><b>{active.handle ?? "resident"}</b>{#if mode === "read"}<StatusPill tone="idle" label="Read · watch only" />{/if}<div class="actions">{#if streamId && mode === "read"}<button class="tonal" disabled={!data.ptyLive || !data.auditWritable} onclick={() => attachOpen = true}>Attach</button>{/if}{#if streamId}<button class="ghost" onclick={closeActive}>Detach</button>{/if}</div></header>
		{#if mode === "write"}<div class="ribbon"><Icon name="keyboard" size={15} /><b>Write · {data.adminName} at the keys · every keystroke is logged.</b></div>{/if}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (terminal focus containment requires an application viewport) -->
		<div class="viewport" role="application" aria-label={`${mode} terminal viewport`} tabindex="0" onfocus={() => contained = true} onkeydown={terminalKey}>{#if streamState === "live"}{#each terminalLines as line, __eachKey58 (__eachKey58)}<div>{line}{#if line.endsWith("$ ")}<span class="cursor"> </span>{/if}</div>{/each}{:else if streamState === "connecting"}<span class="muted">Connecting to {active.host} · {active.tmux_session}:{active.pane_id}</span>{:else}<span class="muted">PTY frame transport is unavailable. No prompt or scrollback is fabricated.</span>{/if}</div>
		<footer><span>{streamState} · seq {frameSeq} · {streamId ?? "no stream id"}</span><span>scrollback {terminalLines.length} / 10,000</span>{#if contained}<span>keys go to the shell · Ctrl+Shift+Q releases</span><button class="ghost" onclick={() => { release(); }}>Release</button>{/if}</footer>
	</section>
{:else}
	<header class="sign"><h1 title="the Judge's Chambers">Terminal</h1><span>Chambers. Admins only. The Doorman logs everyone.</span><small>{data.sessions.length} live sessions · {data.auditWritable ? "audit current" : "audit unverified"}</small><code><Icon name="lock-keyhole" size={11} /> TERM_ADMIN · {data.grantName}</code></header>
	{#if !data.auditWritable}<section class="crack"><Icon name="triangle-alert" size={18} /><div><b>Audit write health cannot be verified. New sessions are blocked until logging is proven writable.</b><span>{data.sessions.length} resident sessions remain visible. No entry without a ledger.</span></div><a href="/signals">Open Signals</a></section>{/if}
		<div class="layout"><main><label class="filter"><Icon name="search" size={14} /><input bind:value={filter} placeholder="Filter sessions" aria-label="Filter terminal sessions" /></label><h2>Resident PTYs</h2>{#each sessions as session, __eachKey59 (__eachKey59)}<div class="session"><span class:good={session.state === "running" && session.io_ok} class="dot"></span><div><code>{session.tmux_session}:{session.pane_id}</code><small class:stale={stale(session.updated_at_epoch)}>{session.host} · up {age(session.started_at_epoch)} · activity {age(session.updated_at_epoch)}{stale(session.updated_at_epoch) ? " · stale" : ""}</small></div><span class="owner">{session.handle?.slice(0, 1).toUpperCase()} <b>{session.handle ?? "unbound"}</b></span><StatusPill tone={session.state === "running" ? "good" : session.state === "crashed" ? "danger" : "warn"} label={session.state} /><div class="actions"><button class="ghost" disabled={busy || !data.ptyLive || !data.auditWritable} title={!data.auditWritable ? "audit write health unverified" : !data.ptyLive ? "pty executor contract unavailable" : "term.watch"} onclick={() => { watch(session); }}><Icon name="eye" size={12} />Watch</button><button class="tonal" disabled={busy || !data.ptyLive || !data.auditWritable || !keyboardViewport} title={!keyboardViewport ? "Write needs a keyboard" : !data.auditWritable ? "audit write health unverified" : "Watch, then attach"} onclick={() => { watch(session); }}><Icon name="keyboard" size={12} />Attach</button><OpButton def={restart} args={{ handle: session.handle }} lanes={data.lanes} executorLive={data.managerLive} /><OpButton def={stop} args={{ handle: session.handle }} lanes={data.lanes} executorLive={data.managerLive} /></div></div>{:else}<div class="empty">No live sessions.<small>Resident PTYs appear when managers run.</small></div>{/each}<h2>Admin sessions</h2><div class="empty">Unavailable until the contracted admin-session projection lands.</div></main><aside><header><Icon name="scroll-text" size={14} /><h2>Audit trail</h2><span>Append-only. Queryable.</span></header>{#each data.audit as entry, __eachKey60 (__eachKey60)}<button class="audit" onclick={() => selectedAudit = entry}><time>{new Date(entry.ts).toLocaleTimeString()}</time><b>{entry.admin}</b><code class:deny={entry.action === "denied"}>{entry.action}</code><span>{entry.host} {entry.tmuxSession}:{entry.paneId}</span></button>{:else}<div class="empty">{data.auditAvailable ? "No entries yet." : "Audit query failed. Nothing rendered."}</div>{/each}</aside></div>
{/if}

<ModalSurface bind:element={auditDialog} open={selectedAudit!==null} variant="dialog" labelledby="audit-title" onclose={() => selectedAudit = null}>{#if selectedAudit}<div class="terminal-dialog"><IconButton class="dialog-close" name="x" label="Close audit detail" autofocus onclick={() => auditDialog?.close()}/><h2 id="audit-title">Audit · {selectedAudit.action}</h2><dl><dt>time</dt><dd>{selectedAudit.ts}</dd><dt>admin</dt><dd>{selectedAudit.admin}</dd><dt>target</dt><dd>{selectedAudit.host} {selectedAudit.tmuxSession}:{selectedAudit.paneId}</dd><dt>stream</dt><dd>{selectedAudit.streamId ?? "—"}</dd><dt>client</dt><dd>{selectedAudit.client ?? "—"}</dd><dt>input ref</dt><dd>{selectedAudit.inputRef ? "sealed · opening requires a separately audited op" : "—"}</dd></dl></div>{/if}</ModalSurface>
<ModalSurface bind:element={attachDialog} open={attachOpen} variant="dialog" labelledby="attach-title" onclose={() => attachOpen = false}><div class="terminal-dialog"><h2 id="attach-title">Attach to {active?.host} · {active?.tmux_session}:{active?.pane_id}?</h2><p>You type as {data.adminName}. Every keystroke is logged.</p><div class="dialog-actions"><!-- svelte-ignore a11y_autofocus --><button class="ghost" autofocus onclick={() => attachDialog?.close()}>Cancel</button><button class="tonal" disabled={busy} onclick={attachActive}>{busy ? "Attaching…" : "Attach"}</button></div></div></ModalSurface>

<style>
	.sign{min-height:40px;display:flex;align-items:center;gap:var(--s-3)}.sign h1{font:400 1.25rem var(--sign)}.sign>span{font:400 .8125rem var(--sign);color:var(--text-3)}.sign small{margin-left:auto;font:400 .75rem var(--mono);color:var(--text-3)}.sign>code{background:var(--s2);padding:var(--s-1) var(--s-2);border-radius:var(--r-xs);display:flex;align-items:center;gap:var(--s-1)}button{font:500 .75rem var(--sans)}.ghost,.tonal{border:0;background:none;color:var(--text);min-height:32px;padding:0 var(--s-2);border-radius:var(--r-sm);display:inline-flex;align-items:center;gap:var(--s-1)}.ghost:hover,.tonal:hover{background:var(--s2)}.tonal{background:var(--petal-soft);color:var(--petal-text)}.layout{display:grid;grid-template-columns:minmax(0,1fr) 344px;gap:var(--s-3)}main{min-width:0}.filter{height:32px;background:var(--s2);display:flex;align-items:center;gap:var(--s-2);padding:0 var(--s-2);border-radius:var(--r-xs)}input{border:0;background:none;color:var(--text);outline:0;width:100%}input:focus{outline:2px solid var(--petal);outline-offset:2px}main h2{font:500 .6875rem var(--mono);text-transform:uppercase;color:var(--text-3);margin:var(--s-3) 0 var(--s-2)}.session{display:grid;grid-template-columns:8px minmax(180px,1fr) 112px 90px minmax(260px,auto);align-items:center;gap:var(--s-2);min-height:48px;background:var(--s1);border-radius:var(--r-xs);padding:0 var(--s-3);margin-top:var(--s-1)}.session:hover{background:var(--s2)}.session .dot{width:8px;height:8px;border-radius:50%;background:var(--text-3)}.session .dot.good{background:var(--good-dot)}.session>div:first-of-type{display:grid;min-width:0}.session small{font:400 .6875rem var(--mono);color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session small.stale{color:var(--warn-text)}.owner{display:inline-flex;align-items:center;gap:var(--s-1);background:var(--s2);border-radius:var(--r-pill);padding:var(--s-1) var(--s-2);font-size:.75rem}.owner b{font-weight:500}.actions{display:flex;gap:var(--s-1);justify-content:flex-end}.actions :global(.op-btn){padding:0 var(--s-2)}aside{background:var(--s1);border-radius:var(--r-xs);padding:var(--s-3)}aside>header{display:flex;align-items:center;gap:var(--s-2);height:32px}aside header span{margin-left:auto;font-size:.6875rem;color:var(--text-3)}.audit{display:grid;grid-template-columns:54px 52px 48px 1fr;gap:var(--s-2);align-items:center;width:100%;min-height:40px;border:0;border-top:1px solid var(--rule);background:none;color:var(--text);text-align:left}.audit:hover{background:var(--s2)}.audit time,.audit code{font-size:.6875rem}.audit span{font:400 .6875rem var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.deny{color:var(--danger-text)}.empty{display:grid;place-items:center;min-height:56px;color:var(--text-3);font-size:.75rem}.crack{display:flex;align-items:center;gap:var(--s-2);background:var(--danger-soft);color:var(--danger-text);padding:var(--s-3);margin-bottom:var(--s-3);border-radius:var(--r-xs)}.crack div{display:grid;margin-right:auto}.crack span{font-size:.75rem;color:var(--text-3)}.crack a{color:var(--petal-text)}.denied{min-height:70vh;display:grid;place-content:center;text-align:center;gap:var(--s-2)}.denied>span{position:relative;color:var(--text-3)}.denied>span :global(svg:last-child){position:absolute;left:calc(50% - 14px);top:18px;color:var(--danger-text)}.denied h1{font:400 1.25rem var(--sign)}.denied p{font-size:.75rem;color:var(--text-3)}.pty{background:var(--s1);border-radius:var(--r-xs);overflow:hidden}.pty>header{display:flex;align-items:center;gap:var(--s-3);height:40px;padding:0 var(--s-3);border-bottom:1px solid var(--rule)}.pty>header b{font-size:.75rem}.pty>header .actions{margin-left:auto}.ribbon{height:32px;display:flex;align-items:center;gap:var(--s-2);padding:0 var(--s-3);background:var(--warn-soft);color:var(--warn-text);font-size:.75rem}.viewport{height:520px;overflow:auto;background:var(--bg);padding:var(--s-4);font:400 .8125rem/1.45 var(--mono);white-space:pre;outline:0}.viewport:focus{box-shadow:inset 0 0 0 2px var(--petal)}.cursor{background:var(--petal-fill);color:var(--on-petal)}.muted{color:var(--text-3)}.pty>footer{height:32px;display:flex;align-items:center;gap:var(--s-3);padding:0 var(--s-3);font:400 .6875rem var(--mono);color:var(--text-3)}.pty>footer button{margin-left:auto}dl{display:grid;grid-template-columns:80px 1fr;font:400 .75rem var(--mono)}dt,dd{padding:var(--s-1);border-bottom:1px solid var(--rule)}@media(max-width:1000px){.layout{grid-template-columns:1fr}.session{grid-template-columns:8px 1fr 112px 80px}.session .actions{grid-column:2/-1;justify-content:flex-start;padding-bottom:var(--s-2)}}@media(max-width:767px){.sign>span,.sign>code{display:none}.session{grid-template-columns:8px 1fr 88px}.session :global(.op-btn),.session :global(.pill){display:none}.session .actions{display:flex;grid-column:2/-1}.layout aside{display:block}.viewport{height:420px}}
	.terminal-dialog h2{font:400 1rem var(--sign);margin-bottom:var(--s-3)}
</style>
