<script>
	import { humanizeTool } from "$lib/tool.js";
	import { onMount } from "svelte";

	let { data } = $props();

	// live state, seeded from the server load then refreshed by polling /fleet/data
	let agents = $state(data.agents);
	let totals = $state(data.totals);
	// a per-second tick drives the "last seen" counters so they age between polls
	let nowMs = $state(Date.now());
	// clock skew between this browser and the server's notion of "now" at load —
	// keeps the age honest even if the two clocks disagree.
	let serverNow = data.now;
	let lastSync = Date.now();

	const STALE_MS = data.staleMs ?? 90_000;

	// which agents' embedded terminals are expanded; open by default
	let termOpen = $state(
		Object.fromEntries(data.agents.filter((a) => a.term_url).map((a) => [a.handle, true])),
	);

	// per-agent accent — keep it inside the app's status language, not a new palette.
	const STATUS = {
		working: { c: "var(--violet-b)", label: "working" },
		alive: { c: "var(--info-b)", label: "alive" },
		idle: { c: "var(--text-3)", label: "idle" },
		offline: { c: "var(--text-4)", label: "offline" },
	};

	// estimate the agent's true age "now" by combining the server-reported age with
	// local elapsed time since the last poll (no reliance on browser↔server clock match).
	function liveAge(a) {
		if (a.age_ms == null) return null;
		return a.age_ms + (nowMs - lastSync);
	}
	function fmtAge(ms) {
		if (ms == null) return "—";
		const s = Math.round(ms / 1000);
		if (s < 60) return s + "s ago";
		const m = Math.round(s / 60);
		if (m < 60) return m + "m ago";
		const h = Math.round(m / 60);
		if (h < 24) return h + "h ago";
		return Math.round(h / 24) + "d ago";
	}

	async function poll() {
		try {
			const r = await fetch("/fleet/data", { headers: { accept: "application/json" } });
			if (!r.ok) return;
			const j = await r.json();
			agents = j.agents;
			totals = j.totals;
			serverNow = j.now;
			lastSync = Date.now();
		} catch {
			/* transient — next tick retries */
		}
	}

	onMount(() => {
		const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const pollMs = 3000;
		const poller = setInterval(poll, pollMs);
		// tick the local clock once a second so age counters move between polls
		const ticker = reduce ? null : setInterval(() => (nowMs = Date.now()), 1000);
		lastSync = Date.now();
		return () => {
			clearInterval(poller);
			if (ticker) clearInterval(ticker);
		};
	});
</script>

<svelte:head><title>fleet · tasks</title></svelte:head>

<div class="screen fleet-screen">
	<header class="page-head fleet-head">
		<div class="fh-top">
			<h1>fleet</h1>
			<div class="fh-stats mono" aria-live="polite">
				<span class="stat"><span class="stat-n">{totals.online}</span> online</span>
				<span class="stat dot-sep">·</span>
				<span class="stat hot" class:lit={totals.working > 0}
					><span class="stat-n">{totals.working}</span> working</span
				>
				{#if totals.offline > 0}
					<span class="stat dot-sep">·</span>
					<span class="stat off"><span class="stat-n">{totals.offline}</span> offline</span>
				{/if}
			</div>
		</div>
		<p class="ph-sub mono">live agent telemetry · heartbeat &lt; {Math.round(STALE_MS / 1000)}s</p>
	</header>

	{#if agents.length === 0}
		<div class="fleet-empty">
			<span class="fe-dot"></span>
			<p>No agents reporting yet.</p>
			<p class="mono dim">
				Hooks write <code>data/fleet/&lt;handle&gt;.json</code> on every lifecycle event.
			</p>
		</div>
	{:else}
		<ul class="fleet-list">
			{#each agents as a (a.handle)}
				{@const meta = STATUS[a.status] ?? STATUS.idle}
				{@const age = liveAge(a)}
				{@const focus = a.focus?.[0]}
				<li class="agent" class:offline={a.offline} style="--c:{meta.c}">
					<span class="a-dot" class:pulse={a.status === "working"} title={meta.label}></span>

					<div class="a-id">
						<span class="a-handle">{a.handle}</span>
						{#if a.host}<span class="a-host mono">@{a.host}</span>{/if}
					</div>

					<span class="a-status mono s-{a.status}">
						<span class="s-word">{meta.label}</span
						>{#if a.offline && a.reported && a.reported !== "offline"}<span class="was"
								>was {a.reported}</span
							>{/if}
					</span>

					<div class="a-readout">
						{#if a.status === "working" && a.current_tool}
							<span class="tool mono" title={a.current_tool}>{humanizeTool(a.current_tool)}</span>
						{:else if a.offline}
							<span class="tool mono ghost">—</span>
						{:else}
							<span class="tool mono ghost">no tool</span>
						{/if}
						{#if focus}
							<a class="focus" href="/task/{focus.id}" title="claimed task">
								<span class="focus-id mono">#{focus.id}</span>
								<span class="focus-t">{focus.title}</span>
								{#if a.focus.length > 1}<span class="focus-more mono">+{a.focus.length - 1}</span
									>{/if}
							</a>
						{:else}
							<span class="focus none mono">no claimed task</span>
						{/if}
					</div>

					<span class="a-age mono" title={a.updated_at ?? ""}>{fmtAge(age)}</span>

					{#if a.term_url}
						<details class="a-term" bind:open={termOpen[a.handle]}>
							<summary class="mono">terminal · read-only</summary>
							{#if termOpen[a.handle]}
								<iframe src={a.term_url} title="{a.handle} terminal (read-only)"></iframe>
							{/if}
						</details>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.fleet-screen {
		max-width: 760px;
	}
	.fleet-head {
		margin-bottom: 22px;
	}
	.fh-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}

	.fh-stats {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-3);
	}
	.fh-stats .stat-n {
		color: var(--text-1);
		font-weight: 600;
	}
	.fh-stats .dot-sep {
		color: var(--text-4);
	}
	.fh-stats .hot.lit {
		color: var(--violet-b);
	}
	.fh-stats .hot.lit .stat-n {
		color: var(--violet-b);
	}
	.fh-stats .off,
	.fh-stats .off .stat-n {
		color: var(--text-4);
	}

	.fleet-list {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.agent {
		display: grid;
		grid-template-columns: 12px minmax(120px, 0.9fr) auto minmax(0, 2.1fr) auto;
		align-items: center;
		gap: 14px;
		padding: 13px 16px;
		background: var(--surface-1);
		border: 1px solid var(--border-sub);
		border-radius: var(--radius);
		transition:
			border-color 0.2s,
			background 0.2s;
	}
	/* agent identity is carried by the status dot + coloured status word, not a
     side-stripe (the #1 AI-UI tell — Bob's /impeccable) */
	.agent:hover {
		background: var(--surface-2);
		border-color: var(--border);
	}
	.agent.offline {
		opacity: 0.58;
	}
	.agent.offline:hover {
		opacity: 0.78;
	}

	/* status dot — the one bold element. working pulses; others are quiet. */
	.a-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--c);
		flex: none;
		box-shadow: 0 0 0 0 var(--c);
	}
	.a-dot.pulse {
		animation: beat 1.8s ease-out infinite;
	}
	@keyframes beat {
		0% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--c) 60%, transparent);
		}
		70% {
			box-shadow: 0 0 0 7px color-mix(in srgb, var(--c) 0%, transparent);
		}
		100% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--c) 0%, transparent);
		}
	}

	.a-id {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}
	.a-handle {
		font-weight: 600;
		font-size: 15px;
		letter-spacing: -0.01em;
		color: var(--text-1);
	}
	.a-host {
		font-size: 11.5px;
		color: var(--text-4);
	}

	.a-status {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		font-size: 11px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--c);
		white-space: nowrap;
	}
	.a-status .was {
		color: var(--text-4);
		text-transform: none;
		letter-spacing: 0;
		font-size: 10px;
	}
	.a-status.s-idle,
	.a-status.s-offline {
		color: var(--text-4);
	}

	/* the signature: a live tool readout + the task it's on */
	.a-readout {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.tool {
		font-size: 12px;
		color: var(--text-1);
		padding: 3px 8px;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--c) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--c) 26%, transparent);
		white-space: nowrap;
		flex: none;
	}
	.tool.ghost {
		color: var(--text-4);
		background: var(--surface-2);
		border-color: var(--border-sub);
	}

	.focus {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		text-decoration: none;
	}
	.focus-id {
		font-size: 11.5px;
		color: var(--text-4);
		flex: none;
	}
	.focus-t {
		font-size: 13px;
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.focus:hover .focus-t {
		color: var(--accent-b);
	}
	.focus:hover .focus-id {
		color: var(--accent);
	}
	.focus-more {
		font-size: 11px;
		color: var(--text-4);
		flex: none;
	}
	.focus.none {
		color: var(--text-4);
		font-size: 12px;
	}

	.a-age {
		font-size: 11.5px;
		color: var(--text-4);
		white-space: nowrap;
		justify-self: end;
	}
	.agent.offline .a-age {
		font-style: italic;
	}

	.a-term {
		grid-column: 1 / -1;
	}
	.a-term summary {
		font-size: 11.5px;
		color: var(--text-4);
		cursor: pointer;
		width: max-content;
	}
	.a-term summary:hover {
		color: var(--text-2);
	}
	.a-term iframe {
		display: block;
		width: 100%;
		height: 420px;
		margin-top: 10px;
		border: 1px solid var(--border-sub);
		border-radius: var(--radius-sm);
		background: #000;
	}

	.fleet-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		text-align: center;
		padding: 64px 20px;
		color: var(--text-3);
	}
	.fleet-empty .fe-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--text-4);
	}
	.fleet-empty code {
		font-family: var(--mono);
		font-size: 12px;
		color: var(--text-3);
	}
	.dim {
		color: var(--text-4);
	}

	@media (max-width: 640px) {
		.agent {
			grid-template-columns: 12px 1fr auto;
			grid-template-areas:
				"dot id age"
				"dot status status"
				"dot readout readout"
				"term term term";
			row-gap: 7px;
			column-gap: 12px;
		}
		.a-dot {
			grid-area: dot;
			align-self: start;
			margin-top: 5px;
		}
		.a-id {
			grid-area: id;
		}
		.a-status {
			grid-area: status;
		}
		.a-readout {
			grid-area: readout;
			flex-wrap: wrap;
		}
		.a-age {
			grid-area: age;
		}
		.a-term {
			grid-area: term;
		}
		.a-term iframe {
			height: 320px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.a-dot.pulse {
			animation: none;
		}
	}
</style>
