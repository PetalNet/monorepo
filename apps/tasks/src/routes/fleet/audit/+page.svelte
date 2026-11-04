<script>
	let { data } = $props();
	const fmt = (ms) => (ms ? new Date(ms).toLocaleString("en-US", { hour12: false }) : "—");
	const dur = (a, b) => (a && b ? Math.round((b - a) / 1000) + "s" : a ? "live" : "—");
</script>

<svelte:head><title>Fleet terminal audit</title></svelte:head>

<main>
	<header>
		<a class="back" href="/fleet">← fleet</a>
		<h1>Terminal audit log</h1>
		<p class="sub">
			Every fleet-terminal session. <strong>rw</strong> sessions capture keystrokes — accountability for
			a root-equivalent shell.
		</p>
	</header>

	{#if data.detail}
		{@const s = data.detail.session}
		<section class="detail">
			<a class="back" href="/fleet/audit">← all sessions</a>
			<h2>Session #{s.id} · <span class="mode mode-{s.mode}">{s.mode}</span> · {s.user}</h2>
			<dl>
				<div>
					<dt>connected</dt>
					<dd>{fmt(s.connect_ts)}</dd>
				</div>
				<div>
					<dt>disconnected</dt>
					<dd>{fmt(s.disconnect_ts)} ({dur(s.connect_ts, s.disconnect_ts)})</dd>
				</div>
				<div>
					<dt>client IP</dt>
					<dd>{s.client_ip || "—"}</dd>
				</div>
				<div>
					<dt>user agent</dt>
					<dd class="ua">{s.user_agent || "—"}</dd>
				</div>
			</dl>
			<h3>Keystroke transcript</h3>
			{#if s.mode === "rw"}
				<pre class="transcript">{data.detail.input || "(no input recorded)"}</pre>
			{:else}
				<p class="ro-note">Read-only session — no input is sent or recorded.</p>
			{/if}
		</section>
	{:else}
		<table>
			<thead>
				<tr
					><th>#</th><th>user</th><th>mode</th><th>connected</th><th>duration</th><th>IP</th><th
						>input</th
					></tr
				>
			</thead>
			<tbody>
				{#each data.sessions as s (s.id)}
					<tr>
						<td>{s.id}</td>
						<td>{s.user}</td>
						<td><span class="mode mode-{s.mode}">{s.mode}</span></td>
						<td>{fmt(s.connect_ts)}</td>
						<td>{dur(s.connect_ts, s.disconnect_ts)}</td>
						<td class="ip">{s.client_ip || "—"}</td>
						<td>
							{#if s.mode === "rw" && s.input_chars > 0}
								<a href="/fleet/audit?session={s.id}">{s.input_chars} chars →</a>
							{:else}—{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="7" class="empty">No terminal sessions recorded yet.</td></tr>
				{/each}
			</tbody>
		</table>
	{/if}
</main>

<style>
	main {
		max-width: 980px;
		margin: 0 auto;
		padding: 1.5rem 1rem 4rem;
		color: var(--text-1);
	}
	.back {
		font-size: 0.85rem;
		color: var(--text-3);
		text-decoration: none;
	}
	.back:hover {
		color: var(--accent);
	}
	h1 {
		font-size: 1.4rem;
		margin: 0.4rem 0 0.2rem;
	}
	.sub {
		color: var(--text-3);
		font-size: 0.9rem;
		margin: 0 0 1.2rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.88rem;
	}
	th {
		text-align: left;
		color: var(--text-4);
		font-weight: 600;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid var(--border);
	}
	td {
		padding: 0.55rem 0.6rem;
		border-bottom: 1px solid var(--border-sub);
	}
	td.ip,
	.ua,
	.transcript {
		font-family: var(--mono);
	}
	td.ip {
		color: var(--text-3);
		font-size: 0.8rem;
	}
	.empty {
		color: var(--text-4);
		text-align: center;
		padding: 2rem;
	}
	.mode {
		font-family: var(--mono);
		font-size: 0.72rem;
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-sm);
	}
	.mode-rw {
		background: color-mix(in oklab, var(--accent) 18%, transparent);
		color: var(--accent-b, var(--accent));
	}
	.mode-ro {
		background: var(--surface-2);
		color: var(--text-3);
	}
	.detail {
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1.2rem;
	}
	.detail h2 {
		font-size: 1.1rem;
		margin: 0.6rem 0 1rem;
	}
	dl {
		display: grid;
		gap: 0.5rem;
		margin: 0 0 1.4rem;
	}
	dl div {
		display: grid;
		grid-template-columns: 120px 1fr;
		gap: 0.8rem;
	}
	dt {
		color: var(--text-4);
		font-size: 0.82rem;
	}
	dd {
		margin: 0;
		font-size: 0.88rem;
		word-break: break-all;
	}
	.transcript {
		background: var(--surface-2);
		border: 1px solid var(--border-sub);
		border-radius: var(--radius-sm);
		padding: 0.8rem;
		white-space: pre-wrap;
		word-break: break-all;
		max-height: 60vh;
		overflow: auto;
		font-size: 0.82rem;
	}
	.ro-note {
		color: var(--text-3);
		font-size: 0.88rem;
	}
	a {
		color: var(--accent);
	}
</style>
