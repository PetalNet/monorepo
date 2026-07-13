<script lang="ts">
	import { opDef } from "$lib/api/ops";
	import type { EdgeRegistryItem, EdgeSessionItem } from "$lib/api/types";
	import Icon from "$lib/components/Icon.svelte";
	import OpButton from "$lib/components/OpButton.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";

	let { data } = $props();
	let filter = $state("");
	let selected = $state<EdgeSessionItem | null>(null);
	let drawer = $state<HTMLDialogElement | null>(null);
	let registryOpen = $state(false);
	let confirming = $state<EdgeRegistryItem | null>(null);
	let ceremonyHandle = $state("");
	let completedFp = $state<string | null>(null);

	const approve = opDef("edge.enroll.approve")!;
	const deny = opDef("edge.enroll.deny")!;
	const redial = opDef("doorman.redial")!;
	const drop = opDef("doorman.session.drop")!;
	const now = Date.now();
	const ageSeconds = (value: string) => Math.max(0, Math.round((now - Date.parse(value)) / 1000));
	const isStale = (line: EdgeSessionItem) => ageSeconds(line.last_seen_at) > 90;
	const age = (value: string) => {
		const seconds = ageSeconds(value);
		return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : seconds < 86400 ? `${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 86400)}d`;
	};
	const lines = $derived(
		data.sessions
			.filter((line) => `${line.handle} ${line.host} ${line.state}`.toLowerCase().includes(filter.trim().toLowerCase()))
			.toSorted((a, b) => (a.state === "open" ? 1 : 0) - (b.state === "open" ? 1 : 0) || a.handle.localeCompare(b.handle)),
	);
	const floorLines = $derived(data.sessions.filter((line) => line.state === "floor"));
	const downLines = $derived(data.sessions.filter((line) => line.state === "closed" || isStale(line)));
	const pending = $derived(data.registry.filter((key) => key.state === "pending" && key.pubkey_fp !== completedFp));
	const handshakes = $derived(data.sessions.reduce((total, line) => total + (line.handshakes_clean_count ?? 0), 0));
	const frogs = $derived(Math.floor(handshakes / 1000));
	const healthFresh = $derived(data.health ? ageSeconds(data.health.updatedAt) <= 30 : false);
	const allOpen = $derived(
		data.health?.state === "open" && data.health.caddyOk && healthFresh && data.sessions.every((line) => line.state === "open" && !isStale(line)),
	);
	const doorLabel = $derived(allOpen ? "open" : data.health?.state ?? "unknown");
	const verdict = $derived(
		allOpen ? "Jeff has the door. All lines open." : data.health?.state === "dark" ? "The edge is dark." : "Can't verify the door. Positive edge health is unavailable.",
	);

	$effect(() => {
		if (selected && drawer && !drawer.open) drawer.showModal();
	});

	function beginCeremony(key: EdgeRegistryItem) {
		confirming = key;
		ceremonyHandle = key.requested_handle ?? "";
	}
	function fingerprint(value: string) {
		return value.match(/.{1,4}/g)?.join(" ") ?? value;
	}
	function boardKey(event: KeyboardEvent) {
		const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-line-row]"));
		const index = rows.indexOf(event.target as HTMLElement);
		if ((event.key === "ArrowDown" || event.key === "ArrowUp") && index >= 0) {
			event.preventDefault();
			rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
		}
	}
</script>

<svelte:window onkeydown={boardKey} />

<div class="sign">
	<h1>Network</h1><span>The Door</span>
	<small class:good={allOpen} class:bad={!allOpen}><Icon name={allOpen ? "circle-check" : "circle-help"} size={14} /> {verdict}</small>
	<time>{new Date().toLocaleString([], { hour12: false, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
</div>

{#if !data.sessionsAvailable || data.health?.state === "dark"}
	<section class="crack" aria-label="Edge health unavailable">
		<Icon name="circle-x" size={18} /><div><b>{data.error ?? "The doorman is dark."}</b><span>Door health and open-line claims require fresh positive evidence. Recovery controls remain gated by executor liveness.</span></div>
	</section>
{:else if !data.health}
	<section class="notice"><Icon name="circle-help" size={16} /><span>Session rows are available, but <code>doorman.edge</code> health is not contracted by console-api. Door and Caddy remain unknown.</span></section>
{/if}

{#each downLines as line}
	<section class="crack" aria-label={`Tunnel incident for ${line.handle}`}>
		<Icon name="triangle-alert" size={18} /><div><b>{line.handle} line {isStale(line) ? "silent" : "down"}.</b><span>Blast radius: {line.handle} on {line.host}; last seen {age(line.last_seen_at)} ago.</span></div>
		<OpButton def={redial} args={{ handle: line.handle }} lanes={data.lanes} executorLive={data.managerLive} label="Redial" staleNote={isStale(line) ? `${age(line.last_seen_at)} stale` : null} />
	</section>
{/each}

<div class="desk">
	<div class="stat"><span>Door</span><b><Icon name={allOpen ? "door-open" : "door-closed"} size={16} />{doorLabel}</b><small>{data.health ? `${data.health.listener} · Caddy ${data.health.caddyOk ? "fine" : "unknown"} · Noise XK` : "listener · Caddy · Noise unknown"}</small></div>
	<button class="stat drill" onclick={() => (registryOpen = !registryOpen)} aria-expanded={registryOpen}><span>Keys</span><b>{data.registryAvailable ? data.registry.filter((key) => key.state === "enrolled").length : "—"}</b><small>enrolled · {pending.length} pending · view registry</small></button>
	<div class="stat"><span>Lines</span><b>{data.sessionsAvailable ? data.sessions.length : "—"}</b><small>{data.sessions.filter((line) => line.state === "open" && !isStale(line)).length} open · {floorLines.length} floor · {downLines.length} down/unknown</small></div>
	<div class="stat"><span>Floor</span><b>{data.sessionsAvailable ? floorLines.length : "—"}</b><small>riding Matrix · {data.managerLive ? "floor standing by" : "manager path unknown"}</small></div>
</div>

{#if floorLines.length}
	<div class="floor"><Icon name="triangle-alert" size={14} /><b>{floorLines.map((line) => line.handle).join(", ")} riding the Matrix floor.</b><span>Envelopes ride Matrix. Delivered, slower.</span></div>
{/if}

<div class="grid">
	<main class="board">
		<header><div><h2>Lines</h2><span>Train Lines</span></div><label><Icon name="search" size={12} /><input bind:value={filter} placeholder="filter lines" aria-label="Filter lines" /></label></header>
		{#if data.observedAt}<div class="watermark">as of {new Date(data.observedAt).toLocaleTimeString()} · line silence &gt;90s renders unknown</div>{/if}
		<div class="cols"><span></span><span>agent</span><span>host</span><span>links</span><span>age</span><span>res</span><span>flap</span><span>state</span></div>
		{#each lines as line}
			{@const stale = isStale(line)}
			<button data-line-row class="line" class:stale onclick={() => (selected = line)}>
				<Icon name="train-front" size={16} /><b>{line.handle}</b><code>{line.host}</code>
				<span class="links">
					<span class="sr">{line.links.map((link) => `${link.role} ${stale ? "unknown" : link.state}`).join(", ")}</span>
					{#each line.links as link}<i class:unknown={stale} class:down={!stale && link.state === "down"} class:warm={!stale && link.state === "warm"} aria-hidden="true"></i>{/each}
					<code>{stale ? "—" : line.links.map((link) => link.rtt_ms == null ? "—" : `${link.rtt_ms}`).join(" · ")}ms</code>
				</span>
				<code>{age(line.established_at)}</code><code>{line.resumes_count}</code><code>{age(line.links.map((link) => link.last_flap_at).find(Boolean) ?? line.established_at)}</code>
				<StatusPill tone={stale ? "idle" : line.state === "open" ? "good" : line.state === "floor" || line.state === "resuming" ? "warn" : "danger"} label={stale ? "unknown" : line.state} />
			</button>
		{:else}<div class="empty">{data.sessionsAvailable ? "No lines match this filter." : "Lines unavailable. No open state is inferred."}</div>{/each}
	</main>

	<aside>
		{#if registryOpen}<section><h2>Registry <span>enrolled keys</span></h2>{#each data.registry as key}<div class="reg"><b>{key.handle ?? key.requested_handle ?? "unbound"}</b><code>{key.pubkey_fp.slice(0, 12)}…</code><StatusPill tone={key.state === "enrolled" ? "good" : key.state === "pending" ? "warn" : "idle"} label={key.state} /></div>{:else}<div class="empty">Registry unavailable.</div>{/each}</section>{/if}
		<section><h2>Enrollment <span>Key Ceremony</span></h2>
			{#each pending as key}
				<div class="key"><Icon name="key-round" size={14} /><code>{fingerprint(key.pubkey_fp).slice(0, 24)}…</code><p>wants {key.requested_handle ?? "unbound"} · {key.source_ip ?? "source unknown"} · {key.first_seen_at ? age(key.first_seen_at) : "time unknown"}</p>
					{#if confirming?.pubkey_fp === key.pubkey_fp}
						<div class="confirm"><small>Confirm the complete key binding</small><code>{fingerprint(key.pubkey_fp)}</code><label>Handle<input bind:value={ceremonyHandle} pattern="[a-z0-9][a-z0-9._-]*" /></label><div class="actions"><OpButton def={approve} args={{ pubkey_fp: key.pubkey_fp, handle: ceremonyHandle }} lanes={data.lanes} executorLive={data.controlPlaneLive} variant="primary" onfired={() => { completedFp = key.pubkey_fp; confirming = null; }} /><button class="plain" onclick={() => (confirming = null)}>Cancel</button></div></div>
					{:else}<div class="actions"><button class="tonal" onclick={() => beginCeremony(key)}>Approve enrollment</button><OpButton def={deny} args={{ pubkey_fp: key.pubkey_fp }} lanes={data.lanes} executorLive={data.edgeLive} variant="ghost" /></div>{/if}
				</div>
			{:else}<div class="empty"><Icon name="key-round" size={14} /> Nobody at the door.</div>{/each}
		</section>
		<section><h2>The Wire <span>last 24h</span></h2>{#each data.wire as event}<p><b>{event.type}</b> · {event.handle} · {event.detail}<time>{age(event.at)}</time></p>{:else}<div class="empty"><Icon name="radio" size={14} />{data.sessionsAvailable ? "Quiet on the wire. Bus history unavailable." : "Wire unavailable."}</div>{/each}</section>
		<div class="frog" title="Jeff the Doorman collects frogs.">{frogs} frogs on Jeff's desk · {handshakes.toLocaleString()} handshakes</div>
	</aside>
</div>

<dialog bind:this={drawer} aria-labelledby="line-detail-title" onclose={() => (selected = null)}>
	{#if selected}<button class="close" autofocus aria-label="Close line details" onclick={() => drawer?.close()}><Icon name="x" size={16} /></button><h2 id="line-detail-title">{selected.handle} · line detail</h2><dl><dt>session</dt><dd>{selected.session_id}</dd><dt>established</dt><dd>{selected.established_at}</dd><dt>resumes</dt><dd>{selected.resumes_count}</dd><dt>last seen</dt><dd>{selected.last_seen_at} · {age(selected.last_seen_at)} ago</dd></dl><h3>Warm links</h3>{#each selected.links as link}<p><b>{link.role}</b> · {isStale(selected) ? "unknown" : link.state} · {isStale(selected) ? "—" : link.rtt_ms ?? "—"}ms · {link.flap_count_24h} flaps / 24h</p>{/each}<h3>Recovery</h3><div class="actions"><OpButton def={redial} args={{ handle: selected.handle }} lanes={data.lanes} executorLive={data.managerLive} /><OpButton def={drop} args={{ session_id: selected.session_id }} lanes={data.lanes} executorLive={data.edgeLive} variant="danger" /></div><h3>What rides this line</h3><p class="muted">Envelope tail requires persisted bus query. No recent payload is fabricated.</p>{/if}
</dialog>

<style>
	.sign{display:flex;align-items:baseline;gap:var(--s-3);min-height:40px}.sign h1{font:400 1.25rem var(--sign)}.sign>span{font-size:.75rem;color:var(--text-3)}.sign small{display:flex;align-items:center;gap:var(--s-1);font:400 .875rem var(--sign);color:var(--warn-text)}.sign small.good{color:var(--jade-text)}.sign time{margin-inline-start:auto;font:400 .75rem var(--mono);color:var(--text-3)}.crack,.floor,.notice{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-3);border-radius:var(--r-xs);margin-top:var(--s-2)}.crack{background:var(--danger-soft);color:var(--danger-text)}.crack div{display:grid;gap:var(--s-1);margin-right:auto}.crack span,.notice{font-size:.75rem;color:var(--text-3)}.notice{background:var(--s1)}.floor{background:var(--warn-soft);color:var(--warn-text)}.floor span{font-size:.75rem;color:var(--text-3);margin-inline-start:auto}.desk{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--s-3);margin:var(--s-3) 0}.stat{border:0;background:var(--s1);border-radius:var(--r-xs);min-height:88px;padding:var(--s-3);text-align:left;color:var(--text)}button.stat{width:100%;cursor:pointer}.stat>span,.stat small{display:block;font-size:.6875rem;color:var(--text-3)}.stat b{display:flex;align-items:center;gap:var(--s-2);font:500 1.25rem var(--mono);margin:var(--s-1) 0}.drill:hover{background:var(--s2)}.grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:var(--s-3)}.board,aside section{background:var(--s1);border-radius:var(--r-xs)}.board header{height:48px;display:flex;align-items:center;padding:0 var(--s-3)}.board h2,aside h2{font-size:.8125rem}.board header span,aside h2 span{font-size:.6875rem;color:var(--text-3);margin-left:var(--s-2)}label{margin-inline-start:auto;background:var(--s2);display:flex;align-items:center;gap:var(--s-1);padding:0 var(--s-2);min-height:32px;border-radius:var(--r-sm)}input{border:0;background:none;outline:0;color:var(--text)}input:focus{outline:2px solid var(--petal);outline-offset:2px}.watermark{padding:0 var(--s-3) var(--s-2);font:400 .6875rem var(--mono);color:var(--text-3)}.cols,.line{display:grid;grid-template-columns:16px minmax(80px,1fr) 48px 118px 56px 32px 56px 78px;gap:var(--s-2);align-items:center}.cols{height:32px;padding:0 var(--s-3);font:500 .6875rem var(--mono);color:var(--text-3)}.line{width:100%;min-height:48px;border:0;border-top:1px solid var(--rule);background:none;color:var(--text);padding:0 var(--s-3);text-align:left}.line:hover{background:var(--s2)}.line.stale{opacity:.72}.line b{font-size:.8125rem;overflow:hidden;text-overflow:ellipsis}.line code{font-size:.6875rem}.links{display:flex;gap:4px;align-items:center}.links i{width:8px;height:12px;background:var(--jade);border-radius:1px}.links i.warm{background:var(--jade-soft);box-shadow:inset 0 0 0 1px var(--jade)}.links i.down{background:var(--danger-dot);box-shadow:none}.links i.unknown{background:none;box-shadow:inset 0 0 0 1px var(--rule-strong)}.links code{margin-left:2px}.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.empty{padding:var(--s-3);font-size:.75rem;color:var(--text-3);display:flex;gap:var(--s-2);align-items:center}aside{display:flex;flex-direction:column;gap:var(--s-3)}aside section{padding:var(--s-3)}.key{margin-top:var(--s-2);padding-top:var(--s-2);border-top:1px solid var(--rule)}.key p,.key small,aside section>p{font-size:.6875rem;color:var(--text-3);margin-top:var(--s-1)}aside section>p{display:flex;gap:var(--s-1)}aside time{margin-inline-start:auto}.confirm{margin-top:var(--s-2);padding:var(--s-2);background:var(--s2);border-radius:var(--r-xs)}.confirm>code{display:block;overflow-wrap:anywhere;line-height:1.8;margin:var(--s-2) 0}.confirm label{display:grid;margin:0;gap:var(--s-1);font:500 .6875rem var(--mono);color:var(--text-3)}.confirm input{background:var(--bg);min-height:32px;padding:0 var(--s-2);border-radius:var(--r-sm)}.actions{display:flex;gap:var(--s-2);flex-wrap:wrap;margin-top:var(--s-2)}.plain,.tonal{border:0;border-radius:var(--r-sm);min-height:32px;padding:0 var(--s-3);color:var(--text);background:none;font-weight:500}.tonal{background:var(--petal-soft);color:var(--petal-text)}.reg{min-height:32px;display:flex;align-items:center;gap:var(--s-2);border-top:1px solid var(--rule);font-size:.75rem}.reg code{font-size:.6875rem;color:var(--text-3);margin-right:auto}.frog{font:400 .6875rem var(--mono);color:var(--text-3)}dialog{width:420px;max-width:calc(100% - 32px);height:100%;max-height:none;margin:0 0 0 auto;border:0;background:var(--s1);color:var(--text);padding:var(--s-4);box-shadow:var(--shadow-pop)}dialog::backdrop{background:rgba(12,10,8,.24)}.close{position:absolute;right:var(--s-3);top:var(--s-3);width:32px;height:32px;border:0;background:none;color:var(--text)}dialog h2{font:400 1.0625rem var(--sign);margin-bottom:var(--s-3)}dl{display:grid;grid-template-columns:100px 1fr;font:400 .6875rem var(--mono)}dt,dd{padding:var(--s-1);border-bottom:1px solid var(--rule)}dt{color:var(--text-3)}dialog h3{font:500 .6875rem var(--mono);text-transform:uppercase;color:var(--text-3);margin-top:var(--s-4)}dialog p{font:400 .75rem var(--mono);margin-top:var(--s-2)}.muted{color:var(--text-3)}@media(max-width:900px){.grid{grid-template-columns:1fr}.cols,.line{grid-template-columns:16px 1fr 48px 100px 56px 32px 56px 70px}}@media(max-width:767px){.sign time{display:none}.desk{grid-template-columns:1fr 1fr}.grid aside,.cols,.line>code,.line>.links{display:none}.line{grid-template-columns:16px 1fr 78px}.floor{align-items:flex-start;flex-direction:column}.floor span{margin:0}}
</style>
