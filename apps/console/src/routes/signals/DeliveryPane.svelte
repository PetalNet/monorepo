<script lang="ts">
	import { connectBus } from "$lib/rpc/browser";
	const env = import.meta.env;
	import Icon from "$lib/components/Icon.svelte";
	import IconButton from "$lib/components/IconButton.svelte";
	import ModalSurface from "$lib/components/ModalSurface.svelte";
	import SegmentedControl from "$lib/components/SegmentedControl.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";
	import { deriveDeliveryLineHealth, type DeliveryLineHealth } from "$lib/data/delivery-health";
	import { snackbar } from "$lib/stores/snackbar.svelte";
	import {
		getDeliverySurface,
		resendDeliveryReceipt,
		sendDeliveryTest,
		setDeliveryCocoon,
		setDeliveryTarget,
	} from "./delivery.remote";
	import { onMount } from "svelte";

	interface Props {
		busObservedAt: string | null;
		onopenfeed: () => void;
		onhealthchange?: (health: DeliveryLineHealth | null) => void;
	}

	let { busObservedAt, onopenfeed, onhealthchange }: Props = $props();
	const deliveryQuery = getDeliverySurface();
	const surface = $derived(deliveryQuery.current ?? null);
	const health = $derived(
		surface
			? deriveDeliveryLineHealth({
					target: surface.delivery?.target ?? null,
					receipts: surface.receipts,
					matrixSyncOkEpoch: surface.matrixSyncOkEpoch,
					busObservedAt: busObservedAt ?? surface.busObservedAt,
				})
			: null,
	);
	const latestTest = $derived(
		surface?.receipts.find(
			(receipt) => receipt.tier === "test" || receipt.signal === "delivery.test",
		) ?? null,
	);
	let targetOpen = $state(false);
	let target = $state("");
	let busy = $state<"test" | "target" | "cocoon" | string | null>(null);
	let result = $state<{ tone: "good" | "danger"; text: string } | null>(null);

	$effect(() => onhealthchange?.(health));
	$effect(() => {
		if (surface?.delivery?.target && !targetOpen) target = surface.delivery.target;
	});

	onMount(() => {
		if (env.PUBLIC_CONSOLE_DATA_MODE !== "live") return;
		return connectBus(
			() => [{ sub_id: "delivery-surface", pattern: "delivery.*" }],
			(frame) => {
				if (frame["kind"] === "event") void deliveryQuery.refresh();
			},
		);
	});

	function nextSeven(): string {
		const next = new Date();
		next.setHours(7, 0, 0, 0);
		if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
		return next.toISOString();
	}

	function time(value: string): string {
		return new Date(value).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	}

	function age(value: string): string {
		const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1_000));
		if (seconds < 60) return `${String(seconds)}s`;
		if (seconds < 3_600) return `${String(Math.round(seconds / 60))}m`;
		if (seconds < 86_400) return `${String(Math.round(seconds / 3_600))}h`;
		return `${String(Math.round(seconds / 86_400))}d`;
	}

	async function testLine() {
		busy = "test";
		result = null;
		try {
			const receipt = await sendDeliveryTest();
			result = {
				tone: "good",
				text: `Delivered and persisted as receipt ${String(receipt["receipt_ref"] ?? "confirmed")}.`,
			};
			snackbar.push({ message: "delivery.test applied", op: "delivery.test", tone: "good" });
		} catch (error) {
			const message = (error as Error).message;
			result = { tone: "danger", text: `Failed. ${message}` };
			snackbar.push({ message: `delivery.test failed: ${message}`, op: "delivery.test", tone: "danger" });
		} finally {
			busy = null;
		}
	}

	async function changeTarget() {
		busy = "target";
		result = null;
		try {
			const receipt = await setDeliveryTarget({ target });
			targetOpen = false;
			result = {
				tone: "good",
				text: `New target verified by persisted receipt ${String(receipt["receipt_ref"] ?? "confirmed")}.`,
			};
			snackbar.push({ message: "delivery.set_target applied", op: "delivery.set_target", tone: "good" });
		} catch (error) {
			const message = (error as Error).message;
			result = { tone: "danger", text: `Target unchanged. ${message}` };
			snackbar.push({ message: `delivery.set_target failed: ${message}`, op: "delivery.set_target", tone: "danger" });
		} finally {
			busy = null;
		}
	}

	async function changeCocoon(mode: "off" | "until") {
		if (!surface?.delivery) return;
		busy = "cocoon";
		try {
			await setDeliveryCocoon({
				until: mode === "off" ? new Date().toISOString() : nextSeven(),
			});
			snackbar.push({ message: "delivery.cocoon applied", op: "delivery.cocoon", tone: "good" });
		} catch (error) {
			snackbar.push({
				message: `delivery.cocoon failed: ${(error as Error).message}`,
				op: "delivery.cocoon",
				tone: "danger",
			});
		} finally {
			busy = null;
		}
	}

	async function resend(receiptRef: string) {
		busy = receiptRef;
		try {
			await resendDeliveryReceipt({ receiptRef });
			snackbar.push({ message: "delivery.resend applied", op: "delivery.resend", tone: "good" });
		} catch (error) {
			snackbar.push({
				message: `delivery.resend failed: ${(error as Error).message}`,
				op: "delivery.resend",
				tone: "danger",
			});
		} finally {
			busy = null;
		}
	}
</script>

{#if !surface}
	<div class="delivery-grid" aria-label="Loading delivery line">
		<main>
			<section class="panel skeleton-panel"><div class="skeleton title"></div><div class="skeleton line"></div><div class="skeleton line short"></div><div class="skeleton control"></div></section>
			<section class="panel skeleton-panel ladder-skeleton">{#each [1, 2, 3] as row (row)}<div class="skeleton row"></div>{/each}</section>
			<section class="panel skeleton-panel">{#each [1, 2, 3, 4] as row (row)}<div class="skeleton receipt"></div>{/each}</section>
		</main>
	</div>
{:else}
	{#if surface.errors.length > 0}
		<div class="verify"><Icon name="circle-help" size={15} />{surface.errors.join(" · ")}. Available delivery evidence continues below.</div>
	{/if}
	{#if health?.state === "failing"}
		<section class="crack" aria-live="polite">
			<Icon name="triangle-alert" size={18} />
			<div class="crack-copy">
				<strong>{health.summary}</strong>
				<span>{health.failingSince ? `Failing since ${time(health.failingSince)} · ` : ""}{health.detail}</span>
				{#if health.backupInterrupts.length > 0}
					<div class="backup" aria-label="Interrupts shown in the console as backup">
						{#each health.backupInterrupts as receipt (receipt.seq)}
							<div><Icon name="siren" size={12} /><time>{time(receipt.ts)}</time><code>{receipt.signal}</code><span>{receipt.subject}</span><b>shown here, not delivered</b></div>
						{/each}
					</div>
				{:else}
					<small>No failed interrupt receipt is available; the stale Matrix executor is the crack evidence.</small>
				{/if}
			</div>
			<div class="crack-actions"><button class="primary" disabled={!surface.executorLive || busy !== null} onclick={testLine}>{busy === "test" ? "Sending…" : "Send a test"}</button><button class="ghost" onclick={() => (targetOpen = true)}>Change target</button></div>
		</section>
	{/if}

	<div class="delivery-grid">
		<main>
			<section class="panel target">
				<header><div><h2>Where interrupts reach you</h2><span>Per user. This line is yours.</span></div></header>
				{#if surface.delivery}
					<button class="target-row" data-ask="Matrix delivery target {surface.delivery.target}" data-ask-kind="delivery-target" aria-label="Change Matrix delivery target" onclick={() => (targetOpen = true)}>
						<Icon name="message-square" size={16} /><b>Matrix DM</b><code>{surface.delivery.target}</code>
						<StatusPill tone={health?.state === "failing" ? "danger" : surface.delivery.verified ? "good" : "warn"} label={health?.state === "failing" ? "failing" : surface.delivery.verified ? "verified" : "not yet verified"} />
					</button>
					{#if latestTest}<div class="last-delivery">last test {time(latestTest.ts)} · {latestTest.status}</div>{/if}
					<div class="actions">
						<button class="tonal" disabled={!surface.executorLive || busy !== null} title={!surface.executorLive ? surface.executorDetail ?? "delivery executor unreachable" : "delivery.test · agent-operable"} onclick={testLine}>{busy === "test" ? "Sending…" : "Send a test"}</button>
						<button class="ghost" disabled={!surface.executorLive || busy !== null} onclick={() => (targetOpen = true)}>Change target</button>
						{#if !surface.executorLive}<span class="disabled-reason">{surface.executorDetail ?? "delivery executor unreachable"}</span>{/if}
					</div>
					{#if result}<div class:good={result.tone === "good"} class:bad={result.tone === "danger"} class="test-result" aria-live="polite"><Icon name={result.tone === "good" ? "circle-check" : "circle-x"} size={14} />{result.text}</div>{/if}
					<div class="cocoon" data-ask="Cocoon mode {surface.delivery.cocoon_until ?? 'off'}; P0 and safety bypass it" data-ask-kind="delivery-cocoon" title="Shawn retires to a slime cocoon when he is done with everyone. S1.">
						<Icon name="bell-off" size={16} /><b>Cocoon mode</b>
						<SegmentedControl label="Cocoon mode" value={surface.delivery.cocoon_until ? "until" : "off"} options={[{ value: "off", label: "Off", disabled: busy === "cocoon" || !surface.executorLive }, { value: "until", label: "Until 07:00", disabled: busy === "cocoon" || !surface.executorLive }]} onchange={changeCocoon} />
						<span>P0 and safety interrupts always come through.</span>
					</div>
					{#if surface.delivery.cocoon_until}<p class="cocoon-state"><Icon name="bell-off" size={13} />Cocoon until {time(surface.delivery.cocoon_until)}. P0 and safety still come through.</p>{/if}
					<footer><span class="agent-presence"><Icon name="sparkles" size={12} />configured by {surface.delivery.updated_by}</span> · {age(surface.delivery.updated_at)} ago · audited</footer>
				{:else}
					<div class="not-connected"><Icon name="phone-forwarded" size={18} /><div><strong>The Mindy Line is not connected.</strong><p>Interrupts show only here in the console until it is. Pick a Matrix target, then send a test.</p></div></div>
					<div class="actions"><button class="primary" disabled={!surface.executorLive} onclick={() => (targetOpen = true)}>Connect Matrix</button><button class="tonal" disabled title="no target yet">Send a test</button><span class="disabled-reason">no target yet</span></div>
				{/if}
			</section>

			<section class="panel ladder wide">
				<header><div><h2>What gets through</h2><span>the fixed escalation ladder</span></div></header>
				<p data-ask="Feed tier: in-console only" data-ask-kind="delivery-tier"><Icon name="inbox" size={16} /><b>Feed</b><span>Rests in the void. Never sent off-console.</span><code>nothing</code></p>
				<p data-ask="Digest tier: scheduled batch" data-ask-kind="delivery-tier"><Icon name="bell" size={16} /><b>Digest</b><span>Batched, polite, on schedule.</span><code>{surface.delivery?.next_digest_at ? `next ${time(surface.delivery.next_digest_at).slice(0, 5)}` : "on demand"}</code></p>
				<p data-ask="Interrupt tier: immediate Matrix delivery" data-ask-kind="delivery-tier"><Icon name="siren" size={16} /><b>Interrupt</b><span>Sent to the Mindy Line the moment it fires.</span><code>Category 55</code></p>
				<div class="recap"><span>{surface.loudSubscriptionCount === 0 ? "Nothing marked loud." : `${String(surface.loudSubscriptionCount)} ${surface.loudSubscriptionCount === 1 ? "subscription" : "subscriptions"} marked loud deliver off-console too.`}</span><button onclick={onopenfeed}>Open the subscribe menu</button></div>
				<footer>Interrupt is reserved: P0, safety, and principal commands only.</footer>
			</section>

			<section class="panel receipts">
				<header><div><h2>Delivery log</h2><span>Recent off-console sends</span></div></header>
				<div class="receipt-head"><span>when</span><span>tier</span><span>signal</span><span>result</span><span>channel</span></div>
				{#if !surface.receiptsAvailable}
					<div class="empty">Query failed. Nothing rendered, nothing pretended.</div>
				{:else}
					{#each surface.receipts as receipt (receipt.seq)}
						<details data-ask="Delivery receipt {receipt.seq}: {receipt.status} {receipt.signal}" data-ask-kind="delivery-receipt">
							<summary><time>{time(receipt.ts)}</time><code class="tier">{receipt.tier}</code><span><b>{receipt.signal}</b> · {receipt.subject}</span><StatusPill tone={receipt.status === "delivered" ? "good" : "danger"} label={receipt.status} /><code>{receipt.channel ?? "matrix"}</code></summary>
							<div class="receipt-detail"><span>{receipt.error ? `Error: ${receipt.error}` : `Receipt ${receipt.seq} · delivered and persisted.`}</span>{#if receipt.error && receipt.retryable}<button class="tonal" disabled={busy !== null} onclick={() => resend(receipt.seq)}>{busy === receipt.seq ? "Resending…" : "Resend"}</button>{/if}</div>
						</details>
					{:else}
						<div class="empty">No off-console sends yet.</div>
					{/each}
				{/if}
				<footer><Icon name="receipt-text" size={12} />stats.query · {surface.receipts.length} receipts · {surface.isMock ? "fixture" : "lake"}</footer>
			</section>
		</main>
		<aside>
			<section class="panel note"><Icon name="smartphone" size={16} /><div><h2>Every device, one line</h2><p>Matrix fans out to every device you are signed in on. Nothing to configure per device.</p></div></section>
			<section class="panel note"><Icon name="flask-conical" size={16} /><div><h2>Under evaluation</h2><p>ntfy with UnifiedPush, and a native lab app. Adopted only if proven better than Matrix on your devices. <a href="/work?task=720">Eval task #720</a>.</p><div class="criteria"><span>reliability</span><span>latency</span><span>per-topic control</span><span>battery</span></div></div></section>
		</aside>
	</div>
{/if}

<ModalSurface open={targetOpen} variant="dialog" labelledby="delivery-target-title" onclose={() => (targetOpen = false)}>
	<IconButton class="dialog-close" name="x" label="Close target dialog" onclick={() => (targetOpen = false)} />
	<h2 id="delivery-target-title">Change Matrix target</h2>
	<p>The old target stays live until the new one passes a test.</p>
	<label>Matrix room or user<input bind:value={target} pattern="^(@|!).+:.+$" autocomplete="off" /></label>
	<div class="actions"><button class="primary" disabled={!surface?.executorLive || busy !== null || !/^(@|!)[^:]+:.+$/.test(target)} title={!surface?.executorLive ? surface?.executorDetail ?? "delivery executor unreachable" : undefined} onclick={changeTarget}>{busy === "target" ? "Testing target…" : "Save and test"}</button><button class="ghost" onclick={() => (targetOpen = false)}>Cancel</button></div>
</ModalSurface>

<style>
	.delivery-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,344px);gap:var(--s-3);align-items:start}.delivery-grid>main,.delivery-grid>aside{display:flex;flex-direction:column;gap:var(--s-3);min-width:0}.panel{background:var(--s1);border-radius:var(--r-xs);padding:var(--s-3);color:var(--text);min-width:0}.panel header{display:flex;align-items:center;min-height:32px}.panel header>div{display:flex;gap:var(--s-2);align-items:baseline}.panel h2{font-size:.8125rem;font-weight:500}.panel header span,.last-delivery{font-size:.6875rem;color:var(--text-3)}.panel footer{display:flex;align-items:center;gap:var(--s-1);font-size:.6875rem;color:var(--text-3);padding-top:var(--s-2);margin-top:var(--s-2);border-top:1px solid var(--rule)}button{font:500 .75rem var(--sans);cursor:pointer}.ghost,.primary,.tonal{border:0;min-height:32px;padding:0 var(--s-2);border-radius:var(--r-sm);display:inline-flex;align-items:center;justify-content:center;gap:var(--s-1)}.ghost{background:none;color:var(--petal-text)}.ghost:hover:not(:disabled){background:var(--s2)}.tonal{background:var(--petal-soft);color:var(--petal-text)}.tonal:hover:not(:disabled){background:color-mix(in srgb,var(--petal) 20%,transparent)}.primary{min-height:40px;background:var(--petal-fill);color:var(--on-petal)}button:disabled{opacity:.48;cursor:not-allowed}.actions{display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap}.disabled-reason{font-size:.6875rem;color:var(--text-3)}.verify,.crack{display:flex;align-items:flex-start;gap:var(--s-2);padding:var(--s-3);margin:var(--s-2) 0;border-radius:var(--r-xs);font-size:.75rem}.verify{background:var(--warn-soft);color:var(--warn-text)}.crack{background:var(--danger-soft);color:var(--danger-text);animation:fracture 360ms var(--ease-standard) both}.crack-copy{display:grid;gap:var(--s-1);min-width:0;margin-right:auto}.crack-copy strong{font-weight:500}.crack-copy>span,.crack-copy>small{color:var(--danger-text)}.crack-actions{display:flex;gap:var(--s-2);flex:none}.backup{display:grid;margin-top:var(--s-1);border-top:1px solid color-mix(in srgb,var(--danger-text) 18%,transparent)}.backup>div{display:grid;grid-template-columns:16px 72px minmax(100px,1fr) minmax(80px,1fr) auto;gap:var(--s-2);align-items:center;min-height:28px;font:400 .6875rem var(--mono)}.backup b{font-weight:500}.target-row{width:calc(100% + 2 * var(--s-2));border:0;background:none;color:var(--text);text-align:left;display:flex;align-items:center;gap:var(--s-2);min-height:40px;margin:var(--s-2) calc(-1 * var(--s-2));padding:0 var(--s-2);border-radius:var(--r-xs);transition:background var(--t)}.target-row:hover,.target-row:focus{background:var(--s2);outline:0}.target-row:focus-visible{outline:2px solid var(--petal);outline-offset:2px}.target-row code{margin-right:auto;overflow:hidden;text-overflow:ellipsis}.target .actions{margin:var(--s-2) 0}.test-result{display:flex;align-items:center;gap:var(--s-1);font-size:.75rem;margin:var(--s-2) 0;animation:result-in 160ms var(--ease-standard)}.test-result.good{color:var(--good-text)}.test-result.bad{color:var(--danger-text)}.cocoon{display:flex;align-items:center;gap:var(--s-2);padding-top:var(--s-2);margin-top:var(--s-2);border-top:1px solid var(--rule)}.cocoon>b{font-size:.8125rem;font-weight:500}.cocoon>span{font-size:.6875rem;color:var(--text-3);margin-left:auto;text-align:right}.cocoon-state{display:flex;align-items:center;gap:var(--s-1);font-size:.75rem;color:var(--warn-text);margin-top:var(--s-2)}.agent-presence{display:inline-flex;align-items:center;gap:var(--s-1);color:var(--jade-text)}.not-connected{display:flex;gap:var(--s-2);padding:var(--s-3) 0}.not-connected strong{font-size:.8125rem;font-weight:500}.not-connected p{font-size:.75rem;color:var(--text-2);margin-top:var(--s-1);max-width:48ch}.ladder p{display:grid;grid-template-columns:16px 72px minmax(0,1fr) auto;gap:var(--s-2);align-items:center;min-height:40px;border-top:1px solid var(--rule)}.ladder p b{font-size:.8125rem;font-weight:500}.ladder p span{font-size:.75rem;color:var(--text-3)}.ladder p code{font-size:.6875rem;color:var(--text-3)}.recap{display:flex;align-items:center;gap:var(--s-2);font-size:.75rem;padding-top:var(--s-2)}.recap span{margin-right:auto}.recap button{min-height:32px;border:0;background:none;color:var(--petal-text)}.receipts .receipt-head,details summary{display:grid;grid-template-columns:80px 70px minmax(140px,1fr) 90px 60px;gap:var(--s-2);align-items:center}.receipt-head{min-height:32px;font:500 .6875rem var(--mono);color:var(--text-3)}details{border-top:1px solid var(--rule);font-size:.75rem}summary{min-height:36px;cursor:pointer;transition:background var(--t)}summary:hover,summary:focus{background:var(--s2);outline:0}summary:focus-visible{outline:2px solid var(--petal);outline-offset:-2px}summary::marker{font-size:.625rem;color:var(--text-3)}summary>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tier{font-size:.6875rem;background:var(--s2);padding:2px 4px;border-radius:var(--r-xs);width:max-content}.receipt-detail{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-2);color:var(--text-3)}.receipt-detail span{margin-right:auto}.empty{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-3);font-size:.75rem;color:var(--text-3)}.note{display:flex;gap:var(--s-2)}.note :global(svg){color:var(--jade-text);flex:none}.note p{font-size:.75rem;color:var(--text-2);margin-top:var(--s-1);max-width:40ch}.criteria{display:flex;flex-wrap:wrap;gap:var(--s-1);margin-top:var(--s-2)}.criteria span{font:400 .6875rem var(--mono);color:var(--text-3);background:var(--s2);padding:2px 4px;border-radius:var(--r-xs)}.skeleton-panel{display:grid;gap:var(--s-2)}.skeleton{background:var(--s2);border-radius:var(--r-xs);animation:skeleton 1.2s ease-in-out infinite alternate}.skeleton.title{height:16px;width:42%}.skeleton.line{height:8px;width:82%}.skeleton.line.short{width:56%}.skeleton.control{height:40px;width:180px}.skeleton.row{height:40px}.skeleton.receipt{height:32px}.ladder-skeleton{margin-top:var(--s-3)}:global(.modal-surface) h2{font:400 1.0625rem var(--sign);margin-bottom:var(--s-2)}:global(.modal-surface)>p{font-size:.75rem;color:var(--text-2);margin-bottom:var(--s-3)}:global(.modal-surface)>label{display:grid;gap:var(--s-1);font:500 .6875rem var(--mono);color:var(--text-3)}:global(.modal-surface) input{border:0;background:var(--s1);color:var(--text);min-height:40px;border-radius:var(--r-sm);padding:0 var(--s-2);outline:0;font:400 .8125rem var(--mono)}:global(.modal-surface) input:focus{outline:2px solid var(--petal);outline-offset:2px}:global(.modal-surface) .actions{margin-top:var(--s-3)}
	.crack{animation:none}
	@keyframes result-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}@keyframes skeleton{to{opacity:.56}}
	@media(max-width:900px){.delivery-grid{grid-template-columns:1fr}.backup>div{grid-template-columns:16px 72px 1fr}.backup>div span,.backup>div b{grid-column:3}.crack{flex-wrap:wrap}.crack-actions{margin-left:24px}}
	@media(max-width:767px){.delivery-grid>aside{display:none}.cocoon{align-items:flex-start;flex-wrap:wrap}.cocoon>span{width:100%;margin-left:24px;text-align:left}.receipts .receipt-head,details summary{grid-template-columns:70px 64px minmax(100px,1fr) 84px}.receipt-head>*:last-child,summary>*:last-child{display:none}.ladder p{grid-template-columns:16px 64px 1fr}.ladder p code{grid-column:3}.crack-actions{width:100%;margin-left:0}.backup>div{grid-template-columns:16px 64px 1fr}}
	@media(prefers-reduced-motion:reduce){.crack,.test-result,.skeleton{animation:none}}
</style>
