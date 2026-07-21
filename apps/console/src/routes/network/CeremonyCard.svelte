<script lang="ts">
	import type { EdgeRegistryItem } from "$lib/api/types";
	import Icon from "$lib/components/Icon.svelte";
	import { snackbar } from "$lib/stores/snackbar.svelte";
	import { runRemote } from "$lib/rpc/browser";
	import { untrack } from "svelte";
	import { approveEnrollment, denyEnrollment } from "./ceremony.remote";

	interface Props {
		item: EdgeRegistryItem;
		canAct: boolean;
		disabledReason: string;
		onchanged: () => void;
	}

	let { item, canAct, disabledReason, onchanged }: Props = $props();
	let stage = $state<"idle" | "approve" | "deny" | "success">("idle");
	let handle = $state(untrack(() => item.requested_handle ?? ""));
	let reason = $state("");
	let busy = $state(false);
	let error = $state<string | null>(null);
	let success = $state("");

	const groups = $derived(item.pubkey_fp.match(/.{1,4}/g) ?? [item.pubkey_fp]);
	const shortFingerprint = $derived(`${groups.slice(0, 4).join(" ")}…`);

	function age(value: string | null | undefined): string {
		if (!value) return "first seen unknown";
		const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1_000));
		if (seconds < 60) return `first seen ${String(seconds)}s ago`;
		if (seconds < 3_600) return `first seen ${String(Math.round(seconds / 60))}m ago`;
		return `first seen ${String(Math.round(seconds / 3_600))}h ago`;
	}

	function finish(message: string, op: "edge.enroll.approve" | "edge.enroll.deny") {
		success = message;
		stage = "success";
		snackbar.push({ message, op, tone: "good" });
		setTimeout(onchanged, 900);
	}

	async function approve() {
		if (!canAct || !handle.trim()) return;
		busy = true;
		error = null;
		try {
			await runRemote(approveEnrollment({ pubkey_fp: item.pubkey_fp, handle: handle.trim() }));
			finish(`Key cut. ${handle.trim()} can use the door now.`, "edge.enroll.approve");
		} catch (cause) {
			error = (cause as Error).message;
			snackbar.push({
				message: `edge.enroll.approve failed: ${error}`,
				op: "edge.enroll.approve",
				tone: "danger",
			});
		} finally {
			busy = false;
		}
	}

	async function deny() {
		if (!canAct || reason.trim().length < 3) return;
		busy = true;
		error = null;
		try {
			await runRemote(denyEnrollment({ pubkey_fp: item.pubkey_fp, reason: reason.trim() }));
			finish("Enrollment denied. The key remains outside the door.", "edge.enroll.deny");
		} catch (cause) {
			error = (cause as Error).message;
			snackbar.push({
				message: `edge.enroll.deny failed: ${error}`,
				op: "edge.enroll.deny",
				tone: "danger",
			});
		} finally {
			busy = false;
		}
	}
</script>

<article class="ceremony-card" class:settled={stage === "success"} aria-live="polite" data-ask={`Pending enrollment ${item.requested_handle ?? "unbound"}, fingerprint ${item.pubkey_fp}, source ${item.source_ip ?? "unknown"}`} data-ask-kind="edge-enrollment">
	{#if stage === "success"}
		<div class="success"><Icon name="circle-check" size={16} /><strong>{success}</strong><span>Audited by the named operation.</span></div>
	{:else}
		<header>
			<Icon name="key-round" size={15} />
			<div><strong>{item.requested_handle ?? "Unbound device"}</strong><code title={item.pubkey_fp}>{shortFingerprint}</code></div>
		</header>
		<dl>
			<div><dt>source</dt><dd><code>{item.source_ip ?? "unknown"}</code></dd></div>
			<div><dt>arrival</dt><dd>{age(item.first_seen_at)}</dd></div>
		</dl>

		{#if stage === "approve"}
			<form class="confirm" onsubmit={(event) => { event.preventDefault(); void approve(); }}>
				<strong>Confirm the complete key binding</strong>
				<p>Compare the full SHA-256 fingerprint with the device before admitting it.</p>
				<code class="fingerprint"><span>{groups.slice(0, 8).join(" ")}</span><span>{groups.slice(8).join(" ")}</span></code>
				<label for={`ceremony-handle-${item.pubkey_fp}`}>Approved handle</label>
				<input id={`ceremony-handle-${item.pubkey_fp}`} bind:value={handle} required pattern="[a-z0-9][a-z0-9._-]*" autocomplete="off" />
				<div class="actions"><button class="primary" type="submit" disabled={!canAct || busy || !handle.trim()} title="edge.enroll.approve">{busy ? "Approving…" : "Approve enrollment"}</button><button class="ghost" type="button" disabled={busy} onclick={() => { stage = "idle"; error = null; }}>Cancel</button></div>
			</form>
		{:else if stage === "deny"}
			<form class="confirm" onsubmit={(event) => { event.preventDefault(); void deny(); }}>
				<strong>Deny this enrollment</strong>
				<p>The reason is required and retained with the audit trail.</p>
				<label for={`ceremony-reason-${item.pubkey_fp}`}>Reason</label>
				<textarea id={`ceremony-reason-${item.pubkey_fp}`} bind:value={reason} required minlength="3" maxlength="500" rows="3" placeholder="Why should this key stay outside?" ></textarea>
				<div class="actions"><button class="danger" type="submit" disabled={!canAct || busy || reason.trim().length < 3} title="edge.enroll.deny">{busy ? "Denying…" : "Deny enrollment"}</button><button class="ghost" type="button" disabled={busy} onclick={() => { stage = "idle"; error = null; }}>Cancel</button></div>
			</form>
		{:else}
			<div class="actions"><button class="tonal" disabled={!canAct} title={canAct ? "edge.enroll.approve" : disabledReason} onclick={() => (stage = "approve")}>Approve enrollment</button><button class="ghost" disabled={!canAct} title={canAct ? "edge.enroll.deny" : disabledReason} onclick={() => (stage = "deny")}>Deny</button></div>
			{#if !canAct}<p class="disabled"><Icon name="lock-keyhole" size={12} />{disabledReason}</p>{/if}
		{/if}
		{#if error}<p class="error"><Icon name="circle-x" size={13} />Not applied. {error}</p>{/if}
	{/if}
</article>

<style>
	.ceremony-card{padding:var(--s-3) 0;border-top:1px solid var(--rule);transition:opacity var(--dur-mid) var(--ease-standard),transform var(--dur-mid) var(--ease-standard)}
	header{display:flex;align-items:flex-start;gap:var(--s-2)}header>div{min-width:0;display:grid;gap:2px}header strong{font-size:.8125rem;font-weight:500}header code{font-size:.6875rem;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
	dl{display:flex;gap:var(--s-3);margin-top:var(--s-2);color:var(--text-3);font-size:.6875rem}dl div{display:flex;gap:var(--s-1)}dt{font:500 .6875rem var(--mono)}dd{margin:0}dd code{font-size:.6875rem}
	.confirm{display:grid;gap:var(--s-2);margin-top:var(--s-3);padding:var(--s-3);background:var(--s2);border-radius:var(--r-xs)}.confirm>strong{font-size:.8125rem}.confirm>p{font-size:.75rem;color:var(--text-3);line-height:1.5}.fingerprint{display:grid;gap:2px;padding:var(--s-2);background:var(--bg);font-size:.6875rem;line-height:1.7;overflow-wrap:anywhere}.confirm label{font:500 .6875rem var(--mono);color:var(--text-3)}input,textarea{width:100%;border:0;border-radius:var(--r-sm);background:var(--bg);color:var(--text);font:400 .8125rem var(--sans);padding:var(--s-2)}input{min-height:40px}textarea{resize:vertical;min-height:72px}input:focus-visible,textarea:focus-visible{outline:2px solid var(--petal);outline-offset:2px}
	.actions{display:flex;flex-wrap:wrap;gap:var(--s-2);margin-top:var(--s-3)}button{border:0;border-radius:var(--r-sm);min-height:40px;padding:0 var(--s-3);font:500 .8125rem var(--sans);color:var(--text);cursor:pointer;transition:background var(--t),transform var(--dur-fast) var(--ease-standard)}button:active:not(:disabled){transform:scale(.97)}button:disabled{opacity:.5;cursor:not-allowed}.primary{background:var(--petal-fill);color:var(--on-petal)}.tonal{background:var(--petal-soft);color:var(--petal-text)}.danger{background:var(--danger-fill);color:var(--on-danger)}.ghost{background:transparent}.ghost:hover:not(:disabled){background:var(--s3)}
	.disabled,.error{display:flex;align-items:center;gap:var(--s-1);margin-top:var(--s-2);font-size:.6875rem;color:var(--text-3)}.error{color:var(--danger-text)}.success{display:grid;grid-template-columns:16px 1fr;gap:var(--s-1) var(--s-2);align-items:center;color:var(--good-text)}.success strong{font-size:.75rem}.success span{grid-column:2;font-size:.6875rem;color:var(--text-3)}
	@media(prefers-reduced-motion:reduce){.ceremony-card,button{transition:none}}
</style>
