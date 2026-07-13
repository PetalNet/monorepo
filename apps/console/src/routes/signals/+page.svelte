<script lang="ts">
	import { onMount, tick, untrack } from "svelte";
	import { page } from "$app/state";
	import { connectBus } from "$lib/api/client";
	import { signalSeverityLabel } from "$lib/api/derive";
	import { canSeeOp, opDef } from "$lib/api/ops";
	import type { CardItem, SignalEmission, SignalSourceModeItem } from "$lib/api/types";
	import type { DeliveryLineHealth } from "$lib/data/delivery-health";
	import AgentPresence from "$lib/components/AgentPresence.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import IconButton from "$lib/components/IconButton.svelte";
	import OpButton from "$lib/components/OpButton.svelte";
	import SegmentedControl from "$lib/components/SegmentedControl.svelte";
	import { snackbar } from "$lib/stores/snackbar.svelte";
	import { getSignalStorms, undoSignalStorm } from "./storms.remote";
	import { getSignalSourceModes, setSignalSourceMode } from "./source-modes.remote";
	import DeliveryPane from "./DeliveryPane.svelte";

	let { data } = $props();
	let pane = $state<"feed" | "delivery">(page.url.searchParams.get("pane") === "delivery" ? "delivery" : "feed");
	let voidOpen = $state(false);
	let voidFilter = $state("");
	let signals = $state<SignalEmission[]>([...untrack(() => data.signals)]);
	let busState = $state<"live" | "connecting" | "silent" | "gap">(untrack(() => data.isMock) ? "live" : "connecting");
	let heartbeatAt = $state<string | null>(untrack(() => data.isMock) ? new Date().toISOString() : null);
	let selectedSignal = $state<SignalEmission | null>(null);
	let selectedCard = $state<CardItem | null>(null);
	let drawer = $state<HTMLDialogElement | null>(null);
	let deliveryHealth = $state<DeliveryLineHealth | null>(null);
	let newPattern = $state("");
	let dismissedStorms = $state<string[]>([]);
	let undoingStorm = $state<string | null>(null);
	let sourceDraft = $state("");
	let sourceModeChanges = $state<Record<string, SignalSourceModeItem>>({});
	const stormQuery = getSignalStorms();
	const sourceModeQuery = getSignalSourceModes();
	const activeStorms = $derived(
		(stormQuery.current ?? []).filter(
			(subscription) => !dismissedStorms.includes(subscription.pattern),
		),
	);
	const subscriptions = $derived([
		...data.subscriptions.map((subscription) => {
			const override = activeStorms.find((storm) => storm.pattern === subscription.pattern);
			if (dismissedStorms.includes(subscription.pattern))
				return {
					...subscription,
					tier: "feed" as const,
					storm: subscription.storm ? { ...subscription.storm, active: false } : undefined,
				};
			return override
				? { ...subscription, tier: "digest" as const, storm: override.storm }
				: subscription;
		}),
		...activeStorms.filter(
			(storm) =>
				!data.subscriptions.some((subscription) => subscription.pattern === storm.pattern),
		),
	]);
	const stormFlowCopy = $derived.by(() => {
		const storm = activeStorms[0]?.storm;
		return storm
			? `${storm.event_count.toLocaleString()} in trigger window · damped since ${new Date(storm.muted_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
			: null;
	});
	const sourceRows = $derived(
		[
			...new Set([
				...signals.map((signal) => signal.source.service),
				...(sourceModeQuery.current ?? []).map((item) => item.source_service),
				...Object.keys(sourceModeChanges),
			]),
		].toSorted(),
	);
	const sourceModeFor = (source: string) =>
		sourceModeChanges[source] ??
		(sourceModeQuery.current ?? []).find((item) => item.source_service === source) ??
		null;
	const developmentSources = $derived(
		sourceRows.filter((source) => sourceModeFor(source)?.mode === "development"),
	);
	const validSourceDraft = $derived(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(sourceDraft));

	const snooze = opDef("signal.snooze")!;
	const subSet = opDef("subscription.set")!;
	const subRemove = opDef("subscription.remove")!;
	const repost = opDef("card.repost")!;
	const park = opDef("card.park")!;
	const sourceMode = opDef("signal.source_mode")!;
	const canManageSources = $derived(canSeeOp(sourceMode, data.lanes));
	const age = (ts: string) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
	const dead = $derived(data.cards.filter((card) => card.state === "dead"));
	const parked = $derived(data.cards.filter((card) => card.state === "parked"));
	const visibleSignals = $derived(signals.filter((signal) => `${signal.type} ${signal.subject} ${signal.source.service} ${signal.scope}`.toLowerCase().includes(voidFilter.toLowerCase())).slice(0, 50));
	const escapePattern = (part: string) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const globMatches = (pattern: string, type: string) => new RegExp(`^${pattern.split(".").map((part) => part === "**" ? ".+" : part === "*" ? "[^.]+" : escapePattern(part)).join("\\.")}$`).test(type);
	const feedSignals = $derived(visibleSignals.filter((signal) => subscriptions.some((subscription) => subscription.tier === "feed" && globMatches(subscription.pattern, signal.type))));
	const actionHttpsHosts = new Set(["tasks.petalcat.dev"]);
	const safeActionHref = (action: string | null | undefined) => {
		if (!action) return null;
		if (action.trimStart().startsWith("//") || action.includes("\\")) return null;
		try {
			const internalBase = new URL("https://console.invalid/");
			const url = new URL(action, internalBase);
			if (url.username || url.password) return null;
			if (url.origin === internalBase.origin) return action;
			return url.protocol === "https:" && actionHttpsHosts.has(url.hostname) ? url.href : null;
		} catch {
			return null;
		}
	};
	const reviewStorm = (pattern: string) => {
		voidFilter = pattern.replace(/\.\*\*?$/, "");
		voidOpen = true;
		pane = "feed";
	};
	const openLoudSubscriptions = async () => {
		pane = "feed";
		await tick();
		const target = document.querySelector<HTMLElement>("[data-loud-subscription]") ?? document.querySelector<HTMLElement>("[data-subscriptions]");
		target?.scrollIntoView({ behavior: "smooth", block: "center" });
		target?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
	};
	const undoStorm = async (pattern: string) => {
		undoingStorm = pattern;
		try {
			await undoSignalStorm({ pattern });
			dismissedStorms = [...dismissedStorms, pattern];
			snackbar.push({
				message: `${pattern} restored to Feed`,
				op: "signal.snooze",
				tone: "good",
			});
		} catch (error) {
			snackbar.push({
				message: `Could not undo storm mute: ${(error as Error).message}`,
				op: "signal.snooze",
				tone: "danger",
			});
		} finally {
			undoingStorm = null;
		}
	};
	const changeSourceMode = async (
		sourceService: string,
		mode: "normal" | "development",
	) => {
		const mutation = await setSignalSourceMode({ sourceService, mode });
		const saved = mutation.item;
		sourceModeChanges = { ...sourceModeChanges, [sourceService]: saved };
		if (sourceDraft === sourceService) sourceDraft = "";
		return mutation;
	};

	$effect(() => { if ((selectedSignal || selectedCard) && drawer && !drawer.open) drawer.showModal(); });

	onMount(() => {
		if (data.isMock) return;
		let lastSeq = Number(signals[0]?.id) || undefined;
		const disconnect = connectBus(
			() => [{ sub_id: "console-signals", pattern: "**", ...(lastSeq ? { since: lastSeq } : {}) }],
			(rawFrame) => {
				const frame = rawFrame as { kind?: string; emission?: SignalEmission; ts?: string; seq?: number; ingest?: Record<string, number> | null };
				if (frame.kind === "heartbeat") {
					heartbeatAt = frame.ts ?? new Date().toISOString();
					const lags = frame.ingest ? Object.values(frame.ingest) : [];
					busState = lags.length > 0 && lags.every((lag) => lag <= 90) ? "live" : "silent";
				}
				if (frame.kind === "event" && frame.emission) {
					lastSeq = frame.seq ?? lastSeq;
					signals = [frame.emission, ...signals.filter((signal) => signal.id !== frame.emission?.id)].slice(0, 50);
					if (frame.emission.type === "subscription.changed") void stormQuery.refresh();
					if (frame.emission.type === "signal.source_mode_changed") void sourceModeQuery.refresh();
				}
				if (frame.kind === "gap" || frame.kind === "resync_required") { busState = "gap"; globalThis.location.reload(); }
			},
			(state) => { if (state === "error" || state === "closed") busState = "silent"; },
		);
		const freshness = setInterval(() => { if (heartbeatAt && Date.now() - Date.parse(heartbeatAt) > 9e4) busState = "silent"; }, 15000);
		return () => { clearInterval(freshness); disconnect(); };
	});

	function keyboard(event: KeyboardEvent) {
		if (event.key === "Escape" && voidOpen) voidOpen = false;
		if (event.key === "q" && document.activeElement?.hasAttribute("data-signal-row")) {
			const pattern = document.activeElement.getAttribute("data-pattern");
			if (pattern) document.querySelector<HTMLButtonElement>(`[data-quiet="${CSS.escape(pattern)}"]`)?.click();
		}
		const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-signal-row]"));
		const index = rows.indexOf(event.target as HTMLElement);
		if ((event.key === "ArrowDown" || event.key === "ArrowUp") && index >= 0) { event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
	}
</script>

<svelte:window onkeydown={keyboard} />

<header class="sign">
	<h1><Icon name="stamp" size={16} />Correspondence</h1><span>Signals · {pane === "feed" ? "System Bus" : "The Mindy Line"}</span>
		<small class:good={pane === "feed" ? busState === "live" : deliveryHealth?.state === "healthy"} class:bad={pane === "feed" ? busState !== "live" : deliveryHealth?.state === "failing"}><Icon name={pane === "feed" ? busState === "live" ? "circle-check" : "circle-help" : deliveryHealth?.state === "failing" ? "triangle-alert" : deliveryHealth?.state === "healthy" ? "phone-forwarded" : "circle-help"} size={13} />{pane === "feed" ? busState === "live" ? `Bus live · heartbeat ${heartbeatAt ? age(heartbeatAt) : "now"} ago${stormFlowCopy ? ` · ${stormFlowCopy}` : ""}` : busState === "gap" ? "Bus gap. Re-read required." : "Can't verify. Bus silent." : deliveryHealth?.summary ?? "Reading delivery evidence…"}</small>
	<div class="sign-actions"><button class="ghost" onclick={() => { voidOpen = !voidOpen; pane = "feed"; }}><Icon name="search" size={13} />{voidOpen ? "Close the Void" : "Open the Void"}</button><SegmentedControl label="Signals pane" value={pane} options={[{ value: "feed", label: "Feed" }, { value: "delivery", label: "Delivery" }]} onchange={(next) => pane = next}/></div>
</header>

{#if data.errors.length}<div class="verify"><Icon name="circle-help" size={15} />{data.errors.join(" · ")}. Available planes continue below.</div>{/if}

{#if pane === "feed" && developmentSources.length > 0}
	<div class="development-notice" aria-live="polite">
		<Icon name="flask-conical" size={16} />
		<span><b>Development mode</b> · {developmentSources.length} {developmentSources.length === 1 ? "source is" : "sources are"} muted off-console. Signals still appear in the feed and Void.</span>
	</div>
{/if}

{#if pane === "feed" && activeStorms.length > 0}
	<section class="storm-list" aria-label="Automatic signal storm mutes">
		{#each activeStorms as subscription (subscription.pattern)}
			<article class:busy={undoingStorm === subscription.pattern} class="storm" aria-live="polite">
				<Icon name="triangle-alert" size={18} />
				<div>
					<strong>Signal storm</strong>
					<p><b>{subscription.storm.event_count.toLocaleString()}</b> events in 5 min from <code>{subscription.pattern}</code> scope. Muted to digest.</p>
					<small>Automatic at {new Date(subscription.storm.muted_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · expires {new Date(subscription.storm.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · threshold {subscription.storm.threshold} / 5 min</small>
				</div>
				<div class="storm-actions">
					<button class="ghost" onclick={() => reviewStorm(subscription.pattern)}>Review events</button>
					<button class="storm-undo" disabled={undoingStorm === subscription.pattern} onclick={() => undoStorm(subscription.pattern)}>{undoingStorm === subscription.pattern ? "Restoring…" : "Undo mute"}</button>
				</div>
			</article>
		{/each}
	</section>
{/if}

{#if pane === "feed"}
	{#if voidOpen}
		<section class="panel void"><header><div><h2>The Void</h2><span>every scoped event, subscribed or not</span></div><label><Icon name="search" size={13} /><input bind:value={voidFilter} aria-label="Filter the Void" placeholder="filter type, subject, source" /></label></header><div class="table-head"><span>when</span><span>severity</span><span>type</span><span>subject</span><span>source</span><span></span></div>{#each visibleSignals as signal}<div class="void-row"><button data-signal-row data-pattern={signal.type} class="row-open" onclick={() => selectedSignal = signal}><time>{new Date(signal.ts).toLocaleTimeString()}</time><b>{signalSeverityLabel(signal.severity)}</b><code>{signal.type}</code><span>{signal.subject}</span><code>{signal.source.agent ?? signal.source.service}</code></button><OpButton def={subSet} args={{ pattern: signal.type, tier: "feed" }} lanes={data.lanes} executorLive={data.consoleLive} label="Subscribe" /></div>{:else}<div class="empty">Nothing in the Void for that filter.</div>{/each}<footer>stats.query · {visibleSignals.length} events · {data.isMock ? "fixture" : "lake"}</footer></section>
	{:else}
		<div class="layout"><main>
			<section class="panel feed"><header><div><h2>Your feed</h2><span>{subscriptions.length} scopes subscribed</span></div><small>newest first</small></header>{#if data.isMock}<div class="digest"><button><Icon name="bell" size={14} /><code>container.update.*</code><b>6</b><span>batched 18:00</span><Icon name="chevron-right" size={14} /></button></div>{/if}{#each activeStorms as subscription}<div class="signal storm-aggregate"><button data-signal-row data-pattern={subscription.pattern} class="row-open" onclick={() => reviewStorm(subscription.pattern)}><span class="dot warn"></span><b class="sev warn">P2</b><code>storm</code><span class="subject">{subscription.pattern} events aggregated while muted</span><small>system:bus</small></button><button class="look" onclick={() => reviewStorm(subscription.pattern)}>×{subscription.storm.event_count.toLocaleString()}</button><span></span><time>{age(subscription.storm.muted_at)}</time></div>{/each}{#each feedSignals as signal}{@const actionHref = safeActionHref(signal.action)}{@const sourceDeveloping = sourceModeFor(signal.source.service)?.mode === "development"}<div class:source-developing={sourceDeveloping} class="signal"><button data-signal-row data-pattern={signal.type} class="row-open" onclick={() => selectedSignal = signal}><span class={`dot ${signal.severity}`}></span><b class={`sev ${signal.severity}`}>{signalSeverityLabel(signal.severity)}</b><code>{signal.type.split(".").at(-1)}</code><span class="subject">{signal.subject}</span><small>{signal.source.agent ?? signal.source.service}{signal.source.host ? `@${signal.source.host}` : ""}{sourceDeveloping ? " · dev" : ""}</small></button>{#if actionHref}<a class="look" href={actionHref}>look here</a>{:else}<span></span>{/if}<span data-quiet={signal.type} class="quiet"><OpButton def={snooze} args={{ type_pattern: signal.type, duration_s: 3600 }} lanes={data.lanes} executorLive={data.consoleLive} label="Quiet 1h" /></span><time>{age(signal.ts)}</time></div>{:else}{#if activeStorms.length === 0}<div class="empty">No mail for you. The void holds the rest.</div>{/if}{/each}<footer>Older mail rests in the Void.</footer></section>
			<section class="panel"><header><div><h2>Dead letters</h2><span>wanted board triage</span></div><small>{dead.length} dead · {parked.length} parked</small></header>{#each dead as card}<div class="dead"><Icon name="mail-x" size={14} /><a href={`/work?task=${card.task_id}`}>#{card.task_id}</a><b>{card.recipient ?? "pool"}</b><code>P{card.priority}</code><span>reaped {card.reaps} · fence {card.fence}</span><time>{age(new Date(card.updated_at_ms).toISOString())}</time><div class="ops"><OpButton def={repost} args={{ card_id: card.card_id }} lanes={data.lanes} executorLive={data.dispatcherLive} /><OpButton def={park} args={{ card_id: card.card_id }} lanes={data.lanes} executorLive={data.dispatcherLive} /><button class="ghost" onclick={() => selectedCard = card}>Inspect</button></div></div>{:else}<div class="empty"><Icon name="mailbox" size={14} />All caught up.</div>{/each}{#if parked.length}<div class="parked"><Icon name="clock" size={14} />{parked.length} parked, waiting on capacity · {parked.flatMap((card) => card.needs).join(", ") || "no eligible worker"}</div>{/if}</section>
		</main><aside>
			<section class="panel" data-subscriptions><header><div><h2>Subscriptions</h2><span>the light menu</span></div></header>{#each subscriptions as subscription}<div class:storm-muted={subscription.storm?.active} class="sub" data-loud-subscription={subscription.loud ? "" : undefined}><div><code>{subscription.pattern}</code>{#if subscription.filter}<small>Filtered · edit through Janet; the current op cannot preserve this filter.</small>{:else}<div class="seg tiers">{#each ["feed", "digest", "interrupt"] as tier}<OpButton def={subSet} args={{ pattern: subscription.pattern, tier, loud: subscription.loud ?? false, note: subscription.note ?? "", window: subscription.window ?? undefined }} lanes={data.lanes} executorLive={data.consoleLive && !subscription.storm?.active} variant={subscription.tier === tier ? "tonal" : "ghost"} label={tier[0].toUpperCase() + tier.slice(1)} />{/each}</div><OpButton def={subSet} args={{ pattern: subscription.pattern, tier: subscription.tier, loud: !subscription.loud, note: subscription.note ?? "", window: subscription.window ?? undefined }} lanes={data.lanes} executorLive={data.consoleLive && !subscription.storm?.active} variant={subscription.loud ? "tonal" : "ghost"} label={subscription.loud ? "Loud" : "Quiet"} />{/if}</div>{#if subscription.storm?.active}<small class="override"><Icon name="triangle-alert" size={12} />Auto-muted to digest · <button disabled={undoingStorm === subscription.pattern} onclick={() => undoStorm(subscription.pattern)}>Undo</button></small>{:else}<small>{subscription.updated_by ?? "unknown"} set this · {subscription.updated_at ? age(subscription.updated_at) : "time unknown"} ago</small>{/if}<span class="remove"><OpButton def={subRemove} args={{ pattern: subscription.pattern }} lanes={data.lanes} executorLive={data.consoleLive} /></span></div>{:else}<div class="empty">No standing subscriptions returned.</div>{/each}<div class="add"><input bind:value={newPattern} aria-label="New subscription pattern" placeholder="add a scope pattern" /><OpButton def={subSet} args={{ pattern: newPattern, tier: "feed" }} lanes={data.lanes} executorLive={data.consoleLive} label="Add" /></div><footer>Edit here or ask Janet. Changes audit.</footer></section>
			<section class="panel source-modes"><header><div><h2>Source delivery</h2><span>development overrides</span></div><small>{developmentSources.length} muted</small></header><p class="source-explainer">Mute alerts from a feed while it is under development. In-console signals keep flowing; all off-console alerts, including P0 and safety, pause until restored.</p><div class="source-list">{#each sourceRows as source}{@const state = sourceModeFor(source)}{@const developing = state?.mode === "development"}<div class:developing class="source-row"><Icon name={developing ? "flask-conical" : "radio"} size={14} /><div><code>{source}</code>{#if state}<AgentPresence handle={state.updated_by} label={developing ? "muted by" : "restored by"} />{:else}<small>Normal delivery · no override</small>{/if}</div><OpButton def={sourceMode} args={{ source_service: source, mode: developing ? "normal" : "development" }} lanes={data.lanes} executorLive={data.consoleLive} variant={developing ? "ghost" : "tonal"} label={developing ? "Return to normal" : "Start dev mode"} execute={() => changeSourceMode(source, developing ? "normal" : "development")} /></div>{/each}</div>{#if canManageSources}<div class="source-add"><input bind:value={sourceDraft} aria-label="Source service to put in development mode" placeholder="source.service name" /><OpButton def={sourceMode} args={{ source_service: sourceDraft, mode: "development" }} lanes={data.lanes} executorLive={data.consoleLive} available={validSourceDraft} unavailableNote="enter exact source.service name" label="Start dev mode" execute={() => changeSourceMode(sourceDraft, "development")} /></div>{/if}<footer><Icon name="bell-off" size={12} />Exact source match · named op · audited · agent-operable</footer></section>
			<section class="panel ladder"><h2>Escalation ladder</h2><p><Icon name="inbox" size={14} /><b>Feed</b><span>stays in your feed</span></p><p><Icon name="bell" size={14} /><b>Digest</b><span>batched on schedule</span></p><small><Icon name="arrow-up" size={12} />promote to loud opts a scope up</small><p><Icon name="siren" size={14} /><b>Interrupt</b><span>reaches you off-console</span></p><footer>Interrupt is reserved: P0, safety, principal command.</footer></section>
			<button class="panel pointer" onclick={() => pane = "delivery"}><Icon name="send" size={14} /><span><b>The Mindy Line</b><small>Interrupts and loud scopes leave the console via Matrix.</small></span></button>
		</aside></div>
	{/if}
{:else}
	<DeliveryPane busObservedAt={busState === "live" ? heartbeatAt : null} onopenfeed={openLoudSubscriptions} onhealthchange={(health) => (deliveryHealth = health)} />
{/if}

<dialog bind:this={drawer} aria-labelledby="drawer-title" onclose={() => { selectedSignal = null; selectedCard = null; }}><IconButton class="dialog-close" name="x" label="Close details" onclick={() => drawer?.close()}/>{#if selectedSignal}<h2 id="drawer-title">{selectedSignal.type}</h2><p>{selectedSignal.subject}</p><dl><dt>severity</dt><dd>{selectedSignal.severity} · {signalSeverityLabel(selectedSignal.severity)}</dd><dt>source</dt><dd>{selectedSignal.source.agent ?? selectedSignal.source.service}</dd><dt>scope</dt><dd>{selectedSignal.scope}</dd><dt>time</dt><dd>{selectedSignal.ts}</dd>{#if selectedSignal.task_id}<dt>task</dt><dd><a href={`/work?task=${selectedSignal.task_id}`}>#{selectedSignal.task_id}</a></dd>{/if}</dl><pre>{JSON.stringify(selectedSignal, null, 2)}</pre><div class="actions"><OpButton def={subSet} args={{ pattern: selectedSignal.type, tier: "feed" }} lanes={data.lanes} executorLive={data.consoleLive} label="Subscribe to this scope" /><OpButton def={snooze} args={{ type_pattern: selectedSignal.type, duration_s: 3600 }} lanes={data.lanes} executorLive={data.consoleLive} /></div>{:else if selectedCard}<h2 id="drawer-title">Card #{selectedCard.task_id}</h2><p>{selectedCard.body}</p><dl><dt>sender</dt><dd>{selectedCard.sender} · {selectedCard.sender_class}</dd><dt>recipient</dt><dd>{selectedCard.recipient ?? "pool"}</dd><dt>reaps</dt><dd>{selectedCard.reaps}</dd><dt>fence</dt><dd>{selectedCard.fence}</dd></dl><h3>Lifecycle</h3><p>posted → claimed → reaped/re-posted → dead</p><div class="actions"><OpButton def={repost} args={{ card_id: selectedCard.card_id }} lanes={data.lanes} executorLive={data.dispatcherLive} /><OpButton def={park} args={{ card_id: selectedCard.card_id }} lanes={data.lanes} executorLive={data.dispatcherLive} /></div>{/if}</dialog>

<style>
	.sign{display:flex;align-items:center;gap:var(--s-3);min-height:40px}.sign h1{display:flex;align-items:center;gap:var(--s-2);font:400 1.25rem var(--sign)}.sign>span,.sign small{font-size:.75rem;color:var(--text-3)}.sign small{display:flex;align-items:center;gap:var(--s-1);color:var(--warn-text)}.sign small.good{color:var(--jade-text)}.sign-actions{margin-left:auto;display:flex;gap:var(--s-2)}button{font:500 .75rem var(--sans)}.ghost,.primary{border:0;background:none;color:var(--petal-text);min-height:32px;padding:0 var(--s-2);border-radius:var(--r-sm);display:inline-flex;align-items:center;gap:var(--s-1)}.ghost:hover{background:var(--s2)}.primary,:global(.op-btn.primary){min-height:40px}.primary{background:var(--petal-fill);color:var(--on-petal)}.seg{display:flex;background:var(--s2);padding:2px;border-radius:var(--r-pill)}.verify{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-3);margin:var(--s-2) 0;border-radius:var(--r-xs);background:var(--warn-soft);color:var(--warn-text);font-size:.75rem}.layout{display:grid;grid-template-columns:minmax(0,600px) minmax(280px,344px);gap:var(--s-3);align-items:start}.layout>main,.layout>aside{display:flex;flex-direction:column;gap:var(--s-3)}.panel{background:var(--s1);border-radius:var(--r-xs);padding:var(--s-3);color:var(--text)}.panel>header{display:flex;align-items:center;min-height:32px}.panel header>div{display:flex;gap:var(--s-2);align-items:baseline}.panel h2{font-size:.8125rem}.panel header span,.panel>span,.panel header small{font-size:.6875rem;color:var(--text-3)}.panel header small{margin-left:auto}.panel footer{font-size:.6875rem;color:var(--text-3);padding-top:var(--s-2);margin-top:var(--s-2);border-top:1px solid var(--rule)}.digest button{width:100%;display:grid;grid-template-columns:16px 1fr 30px 1fr 16px;gap:var(--s-2);align-items:center;min-height:32px;border:0;background:none;color:var(--text-2);text-align:left}.signal{width:100%;display:grid;grid-template-columns:8px 20px 54px minmax(100px,1fr) 88px 56px 0 32px;gap:var(--s-2);align-items:center;min-height:40px;padding:0 var(--s-2);border:0;border-top:1px solid var(--rule);background:none;color:var(--text);text-align:left}.signal:hover,.signal:focus{background:var(--s2)}.signal .dot{width:8px;height:8px;border-radius:50%;background:var(--text-3)}.dot.warn{background:var(--warn-dot)}.dot.danger,.dot.p0{background:var(--danger-dot)}.dot.info{background:var(--petal)}.sev{font:500 .6875rem var(--mono)}.sev.warn{color:var(--warn-text)}.sev.danger,.sev.p0{color:var(--danger-text)}.signal code,.signal small,.signal time{font-size:.6875rem;color:var(--text-3)}.subject{font-size:.8125rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.look{font-size:.75rem;color:var(--petal-text)}.quiet{opacity:0;overflow:visible;position:relative;z-index:2}.signal:hover .quiet,.signal:focus .quiet{opacity:1}.dead{display:grid;grid-template-columns:16px 40px 1fr 24px 1fr 30px;gap:var(--s-2);align-items:center;min-height:64px;border-top:1px solid var(--rule);font-size:.75rem}.dead .ops{grid-column:2/-1}.ops,.actions{display:flex;gap:var(--s-2);flex-wrap:wrap}.parked,.empty{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-3);font-size:.75rem;color:var(--text-3)}.sub{position:relative;padding:var(--s-2) 0;border-top:1px solid var(--rule)}.sub>div{display:flex;align-items:center;gap:var(--s-2)}.sub>div>code{margin-right:auto}.sub small{font-size:.6875rem;color:var(--text-3)}.tiers :global(.op-btn){padding:0 var(--s-1);min-height:32px;font-size:.6875rem}.remove{position:absolute;right:0;bottom:0;opacity:0}.sub:hover .remove{opacity:1}.add{display:flex;gap:var(--s-2);margin-top:var(--s-2)}input{border:0;background:var(--s2);color:var(--text);min-height:32px;border-radius:var(--r-sm);padding:0 var(--s-2);outline:0;width:100%}input:focus{outline:2px solid var(--petal);outline-offset:2px}.ladder p{display:flex;align-items:center;gap:var(--s-2);min-height:40px;border-top:1px solid var(--rule)}.ladder p b{width:72px}.ladder p span{font-size:.75rem;color:var(--text-3)}.ladder>small{display:flex;gap:var(--s-1);color:var(--text-3)}.pointer{border:0;text-align:left;display:flex;gap:var(--s-2)}.pointer span{display:grid}.pointer small,.pointer b{font-size:.75rem}.void header label{margin-left:auto;display:flex;align-items:center;gap:var(--s-1);width:280px}.table-head,.void-row{display:grid;grid-template-columns:76px 54px 150px 1fr 100px 88px;gap:var(--s-2);align-items:center}.table-head{font:500 .6875rem var(--mono);color:var(--text-3);min-height:32px}.void-row{width:100%;border:0;border-top:1px solid var(--rule);background:none;color:var(--text);min-height:36px;text-align:left}.void-row:hover{background:var(--s2)}.void-row>*{overflow:hidden;text-overflow:ellipsis}dialog{width:420px;max-width:calc(100% - 32px);border:0;border-radius:var(--r-lg);background:var(--s1);color:var(--text);padding:var(--s-4);box-shadow:var(--shadow-pop)}dialog:first-of-type{height:100%;max-height:none;margin:0 0 0 auto;border-radius:0}dialog::backdrop{background:rgba(12,10,8,.24)}dialog :global(.dialog-close){position:absolute;right:var(--s-3);top:var(--s-3)}dialog h2{font:400 1.0625rem var(--sign);margin-bottom:var(--s-3)}dialog p{font-size:.75rem;color:var(--text-3);margin:var(--s-2) 0}dialog dl{display:grid;grid-template-columns:80px 1fr;font:400 .75rem var(--mono)}dialog dt,dialog dd{padding:var(--s-1);border-bottom:1px solid var(--rule)}dialog pre{background:var(--s2);padding:var(--s-2);font-size:.6875rem;overflow:auto;max-height:280px}@media(max-width:900px){.layout{grid-template-columns:1fr}.signal{grid-template-columns:8px 20px 54px 1fr 70px 32px}.signal .look,.signal .quiet{display:none}}@media(max-width:767px){.sign>span,.sign small,.sign-actions>.ghost,.layout>aside,.dead,.panel:not(.feed),.signal code,.signal small{display:none}.signal{grid-template-columns:8px 20px 1fr 32px}.sign{align-items:flex-start;flex-wrap:wrap}.sign-actions{margin-left:0}.table-head,.void-row{grid-template-columns:64px 44px 120px 1fr}.table-head>*:nth-child(n+5),.void-row>*:nth-child(n+5){display:none}}
	.storm-list{display:grid;gap:var(--s-2);margin:var(--s-2) 0}.storm{display:flex;align-items:center;gap:var(--s-3);padding:var(--s-3);border-radius:var(--r-xs);background:var(--warn-soft);color:var(--warn-text);transition:opacity 160ms ease-out}.storm.busy{opacity:.68}.storm>div:nth-child(2){display:grid;gap:var(--s-1);min-width:0;margin-right:auto}.storm strong{font-size:.8125rem;font-weight:500}.storm p{font-size:.75rem;color:var(--text-2)}.storm p b,.storm code{font:500 .75rem var(--mono)}.storm small{font:400 .6875rem var(--mono);color:var(--text-3)}.storm-actions{display:flex;gap:var(--s-2);flex:none}.storm-undo{min-height:40px;padding:0 var(--s-2);border:0;border-radius:var(--r-sm);background:var(--petal-fill);color:var(--on-petal)}.storm-undo:hover:not(:disabled){background:color-mix(in srgb,var(--petal-fill) 88%,var(--text))}.storm-undo:disabled{opacity:.62}.storm-undo:focus-visible{outline:2px solid var(--petal);outline-offset:2px}.sub.storm-muted{background:var(--warn-soft);padding-inline:var(--s-2)}.sub .override{display:flex;align-items:center;gap:var(--s-1);color:var(--warn-text)}.sub .override button{border:0;background:none;color:var(--petal-text);min-height:32px;padding:0 var(--s-1)}
	.development-notice{display:flex;align-items:center;gap:var(--s-2);min-height:40px;margin:var(--s-2) 0;padding:0 var(--s-3);border-radius:var(--r-xs);background:var(--warn-soft);color:var(--warn-text);font-size:.75rem;animation:mode-in 160ms var(--ease-standard)}.development-notice b{font-weight:500}.source-explainer{max-width:42ch;margin:var(--s-1) 0 var(--s-2);color:var(--text-2);font-size:.75rem;line-height:1.5}.source-list{border-top:1px solid var(--rule)}.source-row{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:var(--s-2);min-height:56px;border-bottom:1px solid var(--rule);transition:background var(--t)}.source-row.developing{background:var(--warn-soft);color:var(--warn-text)}.source-row>div{display:grid;min-width:0}.source-row code{overflow:hidden;text-overflow:ellipsis;font:500 .75rem var(--mono)}.source-row small{color:var(--text-3);font-size:.6875rem}.source-row :global(.agent-presence){color:inherit}.source-row :global(.op-btn),.source-add :global(.op-btn){min-height:32px;padding:0 var(--s-2);font-size:.6875rem}.source-add{display:flex;gap:var(--s-2);padding-top:var(--s-2)}.source-add input{min-width:0}.source-add :global(.op-btn){flex:none}.source-modes footer{display:flex;align-items:center;gap:var(--s-1)}@keyframes mode-in{from{opacity:.7;transform:translateY(-2px)}to{opacity:1;transform:none}}
	.storm-aggregate .look{border:0;background:none;min-height:32px;font:500 .75rem var(--mono);cursor:pointer}
	.signal.source-developing{background:var(--warn-soft)}.signal.source-developing small{color:var(--warn-text)}
	/* Review fixes: rows own one primary button plus sibling actions; targets stay keyboard-visible. */
	.row-open{display:contents;border:0;background:none;color:inherit;text-align:left}.signal,.void-row{border-left:0;border-right:0;border-bottom:0;background:none}.signal:focus-within,.void-row:focus-within{background:var(--s2)}.signal:focus-within .quiet{opacity:1}.tiers :global(.op-btn){min-height:32px}.sub:focus-within .remove{opacity:1}
	@media(max-width:767px){.storm{align-items:flex-start;flex-wrap:wrap}.storm-actions{width:100%;justify-content:flex-end}}
	@media(prefers-reduced-motion:reduce){.storm{transition:none}.development-notice{animation:none}.source-row{transition:none}}
</style>
