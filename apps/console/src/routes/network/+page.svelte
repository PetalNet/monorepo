<script lang="ts">
	import { required } from "#format";
	import type { PageProps } from "./$types";
	const env = import.meta.env;
	import { opDef } from "$lib/api/ops";
	import { connectBus } from "$lib/rpc/browser";
	import type { EdgeRegistryItem, EdgeSessionItem } from "$lib/api/types";
	import AgentPresence from "$lib/components/AgentPresence.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import IconButton from "$lib/components/IconButton.svelte";
	import ModalSurface from "$lib/components/ModalSurface.svelte";
	import OpButton from "$lib/components/OpButton.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";
	import { snackbar } from "$lib/stores/snackbar.svelte";
	import { onMount } from "svelte";
	import CeremonyCard from "./CeremonyCard.svelte";
	import { getKeyCeremony, revokeKey } from "./ceremony.remote";

	let { data }: PageProps = $props();
	let filter = $state("");
	let selected = $state<EdgeSessionItem | null>(null);
	let drawer = $state<HTMLDialogElement | null>(null);
	let registryOpen = $state(false);
	let revoking = $state<EdgeRegistryItem | null>(null);
	let revokeConfirm = $state("");
	let revokeReason = $state("");
	let revokeBusy = $state(false);
	let revokeError = $state<string | null>(null);
	const ceremonyQuery = getKeyCeremony();
	const ceremony = $derived(ceremonyQuery.current ?? null);

	const redial = required(opDef("doorman.redial"));
	const drop = required(opDef("doorman.session.drop"));
	const now = Date.now();
	const ageSeconds = (value: string) => Math.max(0, Math.round((now - Date.parse(value)) / 1000));
	const isStale = (line: EdgeSessionItem) => ageSeconds(line.last_seen_at) > 90;
	const age = (value: string) => {
		const seconds = ageSeconds(value);
		return seconds < 60 ? `${String(seconds)}s` : seconds < 3600 ? `${String(Math.round(seconds / 60))}m` : seconds < 86400 ? `${String(Math.round(seconds / 3600))}h` : `${String(Math.round(seconds / 86400))}d`;
	};
	const lines = $derived(
		data.sessions
			.filter((line) => `${line.handle} ${line.host} ${line.state}`.toLowerCase().includes(filter.trim().toLowerCase()))
			.toSorted((a, b) => (a.state === "open" ? 1 : 0) - (b.state === "open" ? 1 : 0) || a.handle.localeCompare(b.handle)),
	);
	const floorLines = $derived(data.sessions.filter((line) => line.state === "floor"));
	const downLines = $derived(data.sessions.filter((line) => line.state === "closed" || isStale(line)));
	const pending = $derived(ceremony?.registry.filter((key) => key.state === "pending") ?? []);
	const enrolled = $derived(ceremony?.registry.filter((key) => key.state === "enrolled") ?? []);
	const canAdmin = $derived(data.lanes.includes("admin"));
	const canCeremony = $derived(canAdmin && ceremony?.registry_available === true && ceremony.executor.live);
	const ceremonyDisabledReason = $derived(
		!canAdmin
				? "Admins cut keys"
			: ceremony?.executor.detail ?? "Checking the doorman executor",
	);
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

	onMount(() => {
		if (env.PUBLIC_CONSOLE_DATA_MODE === "mock") return;
		return connectBus(
			() => [{ sub_id: "network-key-ceremony", pattern: "edge.*" }],
			(frame) => {
				if (frame["kind"] === "event") void ceremonyQuery.refresh();
			},
		);
	});

	function beginRevoke(key: EdgeRegistryItem) {
		revoking = key;
		revokeConfirm = "";
		revokeReason = "";
		revokeError = null;
	}

	async function confirmRevoke() {
		if (!revoking?.handle || revokeConfirm.trim().toLowerCase() !== revoking.handle.toLowerCase() || revokeReason.trim().length < 3) return;
		revokeBusy = true;
		revokeError = null;
		try {
			await revokeKey({
				pubkey_fp: revoking.pubkey_fp,
				handle: revoking.handle,
				confirm_name: revokeConfirm.trim(),
				reason: revokeReason.trim(),
			});
			snackbar.push({ message: `Key revoked. ${revoking.handle} cannot use the door.`, op: "edge.key.revoke", tone: "good" });
			revoking = null;
			await ceremonyQuery.refresh();
		} catch (cause) {
			revokeError = (cause as Error).message;
			snackbar.push({ message: `edge.key.revoke failed: ${revokeError}`, op: "edge.key.revoke", tone: "danger" });
		} finally {
			revokeBusy = false;
		}
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

{#each downLines as line, __eachKey36 (__eachKey36)}
	<section class="crack" aria-label={`Tunnel incident for ${line.handle}`}>
		<Icon name="triangle-alert" size={18} /><div><b>{line.handle} line {isStale(line) ? "silent" : "down"}.</b><span>Blast radius: {line.handle} on {line.host}; last seen {age(line.last_seen_at)} ago.</span></div>
		<OpButton def={redial} args={{ handle: line.handle }} lanes={data.lanes} executorLive={data.managerLive} label="Redial" staleNote={isStale(line) ? `${age(line.last_seen_at)} stale` : null} />
	</section>
{/each}

<div class="desk">
	<div class="stat"><span>Door</span><b><Icon name={allOpen ? "door-open" : "door-closed"} size={16} />{doorLabel}</b><small>{data.health ? `${data.health.listener} · Caddy ${data.health.caddyOk ? "fine" : "unknown"} · Noise XK` : "listener · Caddy · Noise unknown"}</small></div>
	<button class="stat drill" onclick={() => (registryOpen = !registryOpen)} aria-expanded={registryOpen}><span>Keys</span><b>{ceremony?.registry_available ? enrolled.length : "—"}</b><small>{ceremony ? `${String(enrolled.length)} enrolled · ${String(pending.length)} pending · view registry` : "checking registry…"}</small></button>
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
		{#each lines as line, __eachKey37 (__eachKey37)}
			{@const stale = isStale(line)}
			<button data-line-row class="line" class:stale onclick={() => (selected = line)}>
				<Icon name="train-front" size={16} /><b>{line.handle}</b><code>{line.host}</code>
				<span class="links">
					<span class="sr">{line.links.map((link) => `${link.role} ${stale ? "unknown" : link.state}`).join(", ")}</span>
					{#each line.links as link, __eachKey38 (__eachKey38)}<i class:unknown={stale} class:down={!stale && link.state === "down"} class:warm={!stale && link.state === "warm"} aria-hidden="true"></i>{/each}
					<code>{stale ? "—" : line.links.map((link) => link.rtt_ms == null ? "—" : String(link.rtt_ms)).join(" · ")}ms</code>
				</span>
				<code>{age(line.established_at)}</code><code>{line.resumes_count}</code><code>{age(line.links.map((link) => link.last_flap_at).find(Boolean) ?? line.established_at)}</code>
				<StatusPill tone={stale ? "idle" : line.state === "open" ? "good" : line.state === "floor" || line.state === "resuming" ? "warn" : "danger"} label={stale ? "unknown" : line.state} />
			</button>
		{:else}<div class="empty">{data.sessionsAvailable ? "No lines match this filter." : "Lines unavailable. No open state is inferred."}</div>{/each}
	</main>

	<aside>
		{#if registryOpen}<section class="registry"><h2>Registry <span>enrolled keys</span></h2>
			{#if !ceremony}<div class="registry-loading" aria-label="Loading key registry" aria-busy="true">{#each [1,2,3] as row (row)}<span></span>{/each}</div>
			{:else if !ceremony.registry_available}<div class="empty"><Icon name="circle-help" size={14} />Registry unavailable. No key state is inferred.</div>
			{:else}{#each ceremony.registry as key (key.pubkey_fp)}<div class="reg" class:revoked={key.state === "revoked"}><div><b>{key.handle ?? key.requested_handle ?? "unbound"}</b><code title={key.pubkey_fp}>{key.pubkey_fp.slice(0, 12)}…</code>{#if key.enrolled_by}<AgentPresence handle={key.enrolled_by} label="enrolled by" />{/if}</div><StatusPill tone={key.state === "enrolled" ? "good" : key.state === "pending" ? "warn" : "idle"} label={key.state} />{#if key.state === "enrolled" && key.handle}<button class="revoke" disabled={!canCeremony} title={canCeremony ? "edge.key.revoke" : ceremonyDisabledReason} onclick={() => { beginRevoke(key); }}>Revoke</button>{/if}</div>{:else}<div class="empty">No keys have reached the registry.</div>{/each}{/if}
		</section>{/if}
		<section><h2>Enrollment <span>Key Ceremony</span></h2>
			{#if !ceremony}<div class="ceremony-loading" aria-label="Loading pending enrollments" aria-busy="true"><span></span><span></span><span></span></div>
			{:else if !ceremony.registry_available}<div class="empty"><Icon name="circle-help" size={14} />Can't verify who is at the door.</div>
			{:else}{#each pending as key (key.pubkey_fp)}<CeremonyCard item={key} canAct={canCeremony} disabledReason={ceremonyDisabledReason} onchanged={() => ceremonyQuery.refresh()} />{:else}<div class="empty"><Icon name="key-round" size={14} /> Nobody at the door.</div>{/each}{/if}
			{#if ceremony && !ceremony.executor.live}<div class="executor-note"><Icon name="lock-keyhole" size={13} /><span>{ceremony.executor.detail}. Review controls stay disabled.</span></div>{/if}
		</section>
		<section><h2>The Wire <span>last 24h</span></h2>{#each data.wire as event, __eachKey39 (__eachKey39)}<p><b>{event.type}</b> · {event.handle} · {event.detail}<time>{age(event.at)}</time></p>{:else}<div class="empty"><Icon name="radio" size={14} />{data.sessionsAvailable ? "Quiet on the wire. Bus history unavailable." : "Wire unavailable."}</div>{/each}</section>
		<div class="frog" title="Jeff the Doorman collects frogs.">{frogs} frogs on Jeff's desk · {handshakes.toLocaleString()} handshakes</div>
	</aside>
</div>

<ModalSurface open={revoking !== null} variant="dialog" labelledby="revoke-key-title" onclose={() => { if (!revokeBusy) revoking = null; }}>
	<IconButton class="dialog-close" name="x" label="Close revoke dialog" disabled={revokeBusy} onclick={() => (revoking = null)} />
	{#if revoking}
		<form class="revoke-dialog" onsubmit={(event) => { event.preventDefault(); void confirmRevoke(); }}>
			<Icon name="key-round" size={18} />
			<h2 id="revoke-key-title">Revoke {revoking.handle}'s key</h2>
			<p>This is permanent. Active sessions on this key will drop, then close. Type the handle to proceed.</p>
			<code>{revoking.pubkey_fp}</code>
			<label for="revoke-confirm">Type <strong>{revoking.handle}</strong></label>
			<input id="revoke-confirm" bind:value={revokeConfirm} autocomplete="off" required />
			<label for="revoke-reason">Reason</label>
			<textarea id="revoke-reason" bind:value={revokeReason} minlength="3" maxlength="500" rows="3" required placeholder="Why is this key being revoked?"></textarea>
			{#if revokeError}<p class="dialog-error"><Icon name="circle-x" size={13} />Not revoked. {revokeError}</p>{/if}
			<div class="actions"><button class="danger" type="submit" disabled={revokeBusy || revokeConfirm.trim().toLowerCase() !== revoking.handle?.toLowerCase() || revokeReason.trim().length < 3}>{revokeBusy ? "Revoking…" : "Revoke key"}</button><button class="plain" type="button" disabled={revokeBusy} onclick={() => (revoking = null)}>Cancel</button></div>
		</form>
	{/if}
</ModalSurface>

<dialog bind:this={drawer} aria-labelledby="line-detail-title" onclose={() => (selected = null)}>
	{#if selected}<button class="close" autofocus aria-label="Close line details" onclick={() => drawer?.close()}><Icon name="x" size={16} /></button><h2 id="line-detail-title">{selected.handle} · line detail</h2><dl><dt>session</dt><dd>{selected.session_id}</dd><dt>established</dt><dd>{selected.established_at}</dd><dt>resumes</dt><dd>{selected.resumes_count}</dd><dt>last seen</dt><dd>{selected.last_seen_at} · {age(selected.last_seen_at)} ago</dd></dl><h3>Warm links</h3>{#each selected.links as link, __eachKey40 (__eachKey40)}<p><b>{link.role}</b> · {isStale(selected) ? "unknown" : link.state} · {isStale(selected) ? "—" : link.rtt_ms ?? "—"}ms · {link.flap_count_24h} flaps / 24h</p>{/each}<h3>Recovery</h3><div class="actions"><OpButton def={redial} args={{ handle: selected.handle }} lanes={data.lanes} executorLive={data.managerLive} /><OpButton def={drop} args={{ session_id: selected.session_id }} lanes={data.lanes} executorLive={data.edgeLive} variant="danger" /></div><h3>What rides this line</h3><p class="muted">Envelope tail requires persisted bus query. No recent payload is fabricated.</p>{/if}
</dialog>

<!-- Legacy Network selectors share this scoped block while the ceremony is extracted below. -->
<!-- svelte-ignore css_unused_selector -->
<style>
	.sign{display:flex;align-items:baseline;gap:var(--s-3);min-height:40px}.sign h1{font:400 1.25rem var(--sign)}.sign>span{font-size:.75rem;color:var(--text-3)}.sign small{display:flex;align-items:center;gap:var(--s-1);font:400 .875rem var(--sign);color:var(--warn-text)}.sign small.good{color:var(--jade-text)}.sign time{margin-inline-start:auto;font:400 .75rem var(--mono);color:var(--text-3)}.crack,.floor,.notice{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-3);border-radius:var(--r-xs);margin-top:var(--s-2)}.crack{background:var(--danger-soft);color:var(--danger-text)}.crack div{display:grid;gap:var(--s-1);margin-right:auto}.crack span,.notice{font-size:.75rem;color:var(--text-3)}.notice{background:var(--s1)}.floor{background:var(--warn-soft);color:var(--warn-text)}.floor span{font-size:.75rem;color:var(--text-3);margin-inline-start:auto}.desk{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--s-3);margin:var(--s-3) 0}.stat{border:0;background:var(--s1);border-radius:var(--r-xs);min-height:88px;padding:var(--s-3);text-align:left;color:var(--text)}button.stat{width:100%;cursor:pointer}.stat>span,.stat small{display:block;font-size:.6875rem;color:var(--text-3)}.stat b{display:flex;align-items:center;gap:var(--s-2);font:500 1.25rem var(--mono);margin:var(--s-1) 0}.drill:hover{background:var(--s2)}.grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:var(--s-3)}.board,aside section{background:var(--s1);border-radius:var(--r-xs)}.board header{height:48px;display:flex;align-items:center;padding:0 var(--s-3)}.board h2,aside h2{font-size:.8125rem}.board header span,aside h2 span{font-size:.6875rem;color:var(--text-3);margin-left:var(--s-2)}label{margin-inline-start:auto;background:var(--s2);display:flex;align-items:center;gap:var(--s-1);padding:0 var(--s-2);min-height:32px;border-radius:var(--r-sm)}input{border:0;background:none;outline:0;color:var(--text)}input:focus{outline:2px solid var(--petal);outline-offset:2px}.watermark{padding:0 var(--s-3) var(--s-2);font:400 .6875rem var(--mono);color:var(--text-3)}.cols,.line{display:grid;grid-template-columns:16px minmax(80px,1fr) 48px 118px 56px 32px 56px 78px;gap:var(--s-2);align-items:center}.cols{height:32px;padding:0 var(--s-3);font:500 .6875rem var(--mono);color:var(--text-3)}.line{width:100%;min-height:48px;border:0;border-top:1px solid var(--rule);background:none;color:var(--text);padding:0 var(--s-3);text-align:left}.line:hover{background:var(--s2)}.line.stale{opacity:.72}.line b{font-size:.8125rem;overflow:hidden;text-overflow:ellipsis}.line code{font-size:.6875rem}.links{display:flex;gap:4px;align-items:center}.links i{width:8px;height:12px;background:var(--jade);border-radius:1px}.links i.warm{background:var(--jade-soft);box-shadow:inset 0 0 0 1px var(--jade)}.links i.down{background:var(--danger-dot);box-shadow:none}.links i.unknown{background:none;box-shadow:inset 0 0 0 1px var(--rule-strong)}.links code{margin-left:2px}.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.empty{padding:var(--s-3);font-size:.75rem;color:var(--text-3);display:flex;gap:var(--s-2);align-items:center}aside{display:flex;flex-direction:column;gap:var(--s-3)}aside section{padding:var(--s-3)}.key{margin-top:var(--s-2);padding-top:var(--s-2);border-top:1px solid var(--rule)}.key p,.key small,aside section>p{font-size:.6875rem;color:var(--text-3);margin-top:var(--s-1)}aside section>p{display:flex;gap:var(--s-1)}aside time{margin-inline-start:auto}.confirm{margin-top:var(--s-2);padding:var(--s-2);background:var(--s2);border-radius:var(--r-xs)}.confirm>code{display:block;overflow-wrap:anywhere;line-height:1.8;margin:var(--s-2) 0}.confirm label{display:grid;margin:0;gap:var(--s-1);font:500 .6875rem var(--mono);color:var(--text-3)}.confirm input{background:var(--bg);min-height:32px;padding:0 var(--s-2);border-radius:var(--r-sm)}.actions{display:flex;gap:var(--s-2);flex-wrap:wrap;margin-top:var(--s-2)}.plain,.tonal{border:0;border-radius:var(--r-sm);min-height:32px;padding:0 var(--s-3);color:var(--text);background:none;font-weight:500}.tonal{background:var(--petal-soft);color:var(--petal-text)}.reg{min-height:32px;display:flex;align-items:center;gap:var(--s-2);border-top:1px solid var(--rule);font-size:.75rem}.reg code{font-size:.6875rem;color:var(--text-3);margin-right:auto}.frog{font:400 .6875rem var(--mono);color:var(--text-3)}dialog{width:420px;max-width:calc(100% - 32px);height:100%;max-height:none;margin:0 0 0 auto;border:0;background:var(--s1);color:var(--text);padding:var(--s-4);box-shadow:var(--shadow-pop)}dialog::backdrop{background:rgba(12,10,8,.24)}.close{position:absolute;right:var(--s-3);top:var(--s-3);width:32px;height:32px;border:0;background:none;color:var(--text)}dialog h2{font:400 1.0625rem var(--sign);margin-bottom:var(--s-3)}dl{display:grid;grid-template-columns:100px 1fr;font:400 .6875rem var(--mono)}dt,dd{padding:var(--s-1);border-bottom:1px solid var(--rule)}dt{color:var(--text-3)}dialog h3{font:500 .6875rem var(--mono);text-transform:uppercase;color:var(--text-3);margin-top:var(--s-4)}dialog p{font:400 .75rem var(--mono);margin-top:var(--s-2)}.muted{color:var(--text-3)}@media(max-width:900px){.grid{grid-template-columns:1fr}.cols,.line{grid-template-columns:16px 1fr 48px 100px 56px 32px 56px 70px}}@media(max-width:767px){.sign time{display:none}.desk{grid-template-columns:1fr 1fr}.grid aside,.cols,.line>code,.line>.links{display:none}.line{grid-template-columns:16px 1fr 78px}.floor{align-items:flex-start;flex-direction:column}.floor span{margin:0}}
	.reg{min-height:48px}.reg>div{min-width:0;display:grid;gap:1px;margin-right:auto}.reg>div code{margin:0}.reg.revoked{opacity:.62}.revoke{border:0;border-radius:var(--r-sm);min-height:32px;padding:0 var(--s-2);background:none;color:var(--danger-text);font:500 .75rem var(--sans);cursor:pointer}.revoke:hover:not(:disabled){background:var(--danger-soft)}button:disabled{opacity:.48;cursor:not-allowed}.executor-note{display:flex;align-items:flex-start;gap:var(--s-2);padding:var(--s-2);margin-top:var(--s-2);background:var(--warn-soft);color:var(--warn-text);font-size:.6875rem}.ceremony-loading,.registry-loading{display:grid;gap:var(--s-2);padding-top:var(--s-3)}.ceremony-loading span,.registry-loading span{height:10px;background:var(--s2);border-radius:var(--r-xs);animation:skeleton 1.2s ease-in-out infinite alternate}.ceremony-loading span:first-child{height:16px;width:56%}.ceremony-loading span:last-child{height:40px;width:72%}.registry-loading span{height:32px}.revoke-dialog{display:grid;gap:var(--s-2)}.revoke-dialog>svg{color:var(--danger-text)}.revoke-dialog h2{font:400 1.0625rem var(--sign)}.revoke-dialog p{font-size:.75rem;color:var(--text-2);line-height:1.6}.revoke-dialog>code{font-size:.6875rem;overflow-wrap:anywhere;padding:var(--s-2);background:var(--s1)}.revoke-dialog label{display:grid;margin:0;padding:0;background:none;gap:var(--s-1);font:500 .6875rem var(--mono);color:var(--text-3)}.revoke-dialog input,.revoke-dialog textarea{width:100%;border:0;border-radius:var(--r-sm);background:var(--s1);color:var(--text);font:400 .8125rem var(--sans);padding:var(--s-2)}.revoke-dialog input{min-height:40px}.revoke-dialog textarea{resize:vertical}.revoke-dialog input:focus-visible,.revoke-dialog textarea:focus-visible{outline:2px solid var(--petal);outline-offset:2px}.revoke-dialog .danger{border:0;border-radius:var(--r-sm);min-height:40px;padding:0 var(--s-3);background:var(--danger-fill);color:var(--on-danger);font:500 .8125rem var(--sans)}.dialog-error{display:flex;align-items:center;gap:var(--s-1);color:var(--danger-text)!important}@keyframes skeleton{to{opacity:.56}}@media(prefers-reduced-motion:reduce){.ceremony-loading span,.registry-loading span{animation:none}}
	</style>
