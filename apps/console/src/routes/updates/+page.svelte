<script lang="ts">
	import { dataMode, readBoxUpdateRaw } from "$lib/api/client";
	import { opDef } from "$lib/api/ops";
	import type { BoxUpdateRaw } from "$lib/api/types";
	import HudChip from "$lib/components/HudChip.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import OpButton from "$lib/components/OpButton.svelte";
	import Panel from "$lib/components/Panel.svelte";
	import SurfaceSign from "$lib/components/SurfaceSign.svelte";
	import UpdateRow from "$lib/components/UpdateRow.svelte";
	import { mockRawUpdate, type UpdateRowView } from "$lib/data/updates";
	import { snackbar } from "$lib/stores/snackbar.svelte";

	let { data } = $props();
	const u = $derived(data.updates);
	const rawDetails = $derived(
		data.raw.length ? data.raw : dataMode() === "mock" ? u.rows.map((row) => mockRawUpdate(row.boxId)) : [],
	);
	const criticalUpdates = $derived((u.hud.securityCritical ?? 0) > 0);
	const empty = $derived(u.rows.length === 0);
	let selected = $state<UpdateRowView | null>(null);
	let raw = $state<BoxUpdateRaw | null>(null);
	let rawLoading = $state(false);
	let rawError = $state<string | null>(null);
	let receiptOpen = $state(false);
	let filter = $state("");
	const filteredRows = $derived(
		u.rows.filter((row) =>
			`${row.host} ${row.status} ${row.source}`.toLowerCase().includes(filter.trim().toLowerCase()),
		),
	);
	const criticalFindings = $derived(
		rawDetails.flatMap((detail) =>
			detail.vulns
				.filter((vuln) => vuln.severity === "critical")
				.map((vuln) => ({ ...vuln, boxId: detail.box_id })),
		),
	);
	const criticalCve = $derived(criticalFindings.length > 0);
	const approve = opDef("updates.approve")!;
	const apply = opDef("updates.apply")!;
	const check = opDef("updates.check")!;
	const notify = opDef("task.dispatch")!;
	const reboot = opDef("host.reboot")!;
	let drawerEl = $state<HTMLDialogElement | null>(null);
	let receiptEl = $state<HTMLDialogElement | null>(null);

	$effect(() => {
		if (selected && drawerEl && !drawerEl.open) drawerEl.showModal();
	});
	$effect(() => {
		if (receiptOpen && receiptEl && !receiptEl.open) receiptEl.showModal();
	});

	function executorLive(row: UpdateRowView): boolean {
		return u.executorLiveHosts.includes(row.host);
	}

	async function openRow(row: UpdateRowView) {
		if (matchMedia("(max-width: 767px)").matches) {
			askMode(row);
			return;
		}
		selected = row;
		raw = rawDetails.find((detail) => detail.box_id === row.boxId) ?? null;
		rawError = null;
		if (raw) return;
		if (!row.pending && !row.vulns && !row.rebootRequired) return;
		rawLoading = true;
		try {
			raw = dataMode() === "mock" ? mockRawUpdate(row.boxId) : await readBoxUpdateRaw(row.boxId);
		} catch (error) {
			rawError = (error as Error).message || "Detail is not available from the collector.";
		} finally {
			rawLoading = false;
		}
	}

	function boardKey(event: KeyboardEvent) {
		const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-update-row]"));
		const index = rows.indexOf(event.target as HTMLElement);
		if ((event.key === "ArrowDown" || event.key === "ArrowUp") && index >= 0) {
			event.preventDefault();
			rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
		}
	}

	function askMode(row: UpdateRowView) {
		snackbar.push({
			message: `Context ready: change ${row.host} apply mode with Janet`,
			tone: "good",
		});
	}
</script>

<svelte:window onkeydown={boardKey} />

<SurfaceSign
	title="Updates"
	verdict={!u.connected
		? "cant_verify"
		: criticalCve
			? "cracked"
			: empty || u.securityUnknown || u.remainder || u.truncated || criticalUpdates
				? "needs_you"
				: "fine"}
	stateFact={criticalCve
			? `Critical CVE on ${new Set(criticalFindings.map((finding) => finding.boxId)).size} host${new Set(criticalFindings.map((finding) => finding.boxId)).size === 1 ? "" : "s"}.`
		: criticalUpdates
			? `${u.hud.securityCritical} security-critical update${u.hud.securityCritical === 1 ? "" : "s"} wait on you.`
			: u.securityUnknown
				? `Nothing known critical.${u.remainder ? ` ${u.remainder}.` : ""}`
				: u.truncated
					? "Partial fleet result. Counts are not complete."
					: u.remainder
						? `Nothing critical. ${u.remainder}.`
						: empty
							? "No boxes are visible in this scope."
							: "Nothing critical."}
/>

{#if !u.connected}
	<div class="unverified" role="status">
		<Icon name="circle-help" size={20} />
		<p>Can't read update state. The last known board is unavailable, so nothing is shown as current.</p>
	</div>
{:else}
	<div class="hud" aria-label="Update summary">
		<HudChip
			tone={criticalUpdates ? "danger" : "idle"}
			count={u.hud.securityCritical ?? "—"}
			label="security-critical"
		/>
		<HudChip tone={u.hud.owing ? "warn" : "idle"} count={u.hud.owing} label="owe updates" />
		<HudChip tone="idle" count={u.hud.reboots ?? "—"} label="reboots pending" />
	</div>

	{#if criticalCve}
		<section class="crack" aria-labelledby="critical-cve-title">
			<div id="critical-cve-title" class="crack-title">
				<Icon name="triangle-alert" size={16} />
				Critical CVE on {new Set(criticalFindings.map((finding) => finding.boxId)).size} host{new Set(criticalFindings.map((finding) => finding.boxId)).size === 1 ? "" : "s"}. Giant ladybugs. Patch plan below.
			</div>
			<div class="crack-meta">
				{[...new Set(criticalFindings.map((finding) => finding.cve_id))].join(", ")} · exploit suspected, not confirmed
			</div>
			{#if selected}<div class="actions">
				{#if selected.agentless}
					<span>notify only · no executor on this box</span>
				{:else if selected.applyMode === "staged-approval"}
					<OpButton def={approve} args={{ box_id: selected.boxId }} lanes={u.lanes} variant="primary" label="Approve" />
					<OpButton def={apply} args={{ box_id: selected.boxId }} lanes={u.lanes} executorLive={executorLive(selected)} />
				{:else if selected.applyMode === "manual-notify-only"}
					<span>Notify only. Apply is disabled by this host's mode.</span>
				{:else if selected.applyMode === "auto"}
					<OpButton def={apply} args={{ box_id: selected.boxId }} lanes={u.lanes} executorLive={executorLive(selected)} />
				{:else}
					<span>apply mode unknown · ask Janet before acting</span>
				{/if}
			</div>{/if}
			<p>The facade cracks so you never have to wonder.</p>
		</section>
	{/if}

	{#if empty}
		<div class="empty" role="status">
			<Icon name="shield-check" size={20} />
			<p>No boxes are visible in this scope. Ask Janet which grants include update posture.</p>
		</div>
	{:else}
		<label class="filter"><Icon name="search" size={14} /><span class="sr-only">Filter update rows</span><input bind:value={filter} placeholder="Filter hosts and status" /></label>
		<div class="board" role="group" aria-label="Reboots board">
			<div class="head" aria-hidden="true">
				<span>host</span><span>status</span><span>pending</span><span>security</span><span>vulns</span>
				<span>reboot</span><span>mode</span><span>checked</span><span>applied</span><span>source</span>
			</div>
			{#each filteredRows as row (row.boxId)}
				<UpdateRow
					{row}
					active={selected?.boxId === row.boxId}
					onselect={openRow}
					onaskmode={askMode}
				/>
			{/each}
			<div class="prov">
				<Icon name="receipt-text" size={12} />
				<span>
					{u.freshness?.source ?? "box_update_status"} · {selected ? `1 of ${filteredRows.length} · drawer focus` : `${filteredRows.length} of ${u.rows.length} boxes`}{u.truncated ? " · partial result" : ""}
				</span>
				<button type="button" onclick={() => (receiptOpen = true)}>Show the math.</button>
			</div>
		</div>
	{/if}

	<div class="lower">
		<Panel
			title="Vulnerabilities"
			sub="Tampering Watch · suspected until confirmed"
			span={7}
			prov={{ source: "box update raw detail", freshness: raw ? "selected host" : "open a host", rows: raw ? `${raw.vulns.length} findings` : null }}
		>
			{#if rawLoading}
				<div class="skeletons" aria-label="Loading vulnerability detail"><i></i><i></i><i></i></div>
			{:else if rawError}
				<div class="detail-error"><Icon name="circle-alert" size={14} /> Can't read collector detail. Counts remain above.</div>
			{:else if raw?.vulns.length}
				<div class="cves">
					{#each raw.vulns as vuln (vuln.cve_id)}
						<div class="cve">
							<span class="severity {vuln.severity}">{vuln.severity}</span>
							<code>{vuln.cve_id}</code><span>{vuln.package}</span>
							<span class="fixed">{vuln.fixed_in ? `fix ${vuln.fixed_in}` : "no fix listed"}</span>
						</div>
					{/each}
				</div>
			{:else if raw}
				<div class="quiet"><Icon name="shield-check" size={14} /> No known vulnerabilities. Tampering watch is quiet.</div>
			{:else}
				<div class="quiet">Open a host to inspect its collector detail. Aggregate counts stay visible in the board.</div>
			{/if}
		</Panel>

		<Panel
			title="Container updates"
			sub="Derek · digest-batched"
			span={5}
			prov={{ source: "container.update_available", freshness: dataMode() === "mock" ? "mock live" : "history unavailable", rows: dataMode() === "mock" ? "3 updates" : null }}
		>
			{#if dataMode() === "mock"}
				<div class="containers">
					<div><code>citeseer-web</code><span>.14 · 1.8.2 → 1.9.0</span><time>2h</time></div>
					<div><code>tasks-app</code><span>.202 · ab12f → 9c04e</span><time>5h</time></div>
					<div><code>matrix-bridge</code><span>.12 · 0.4.1 → 0.4.3</span><time>9h</time></div>
				</div>
			{:else}
				<div class="quiet">Container event history is not available from the current read contract.</div>
			{/if}
		</Panel>
	</div>
{/if}

{#if selected}
	<dialog
		bind:this={drawerEl}
		class="drawer"
		aria-label="Update detail for {selected.host}"
		onclose={() => (selected = null)}
	>
		<button class="close" type="button" aria-label="Close detail" onclick={() => drawerEl?.close()}>
			<Icon name="x" size={16} />
		</button>
		<h2>Pending approval · {selected.host}</h2>
		<p class="drawer-meta">
			{selected.applyMode ?? "mode unknown"} · {selected.pending ?? "unknown"} updates · {selected.securityCritical ?? "unknown"} security · {selected.source}
		</p>
		{#if rawLoading}
			<div class="skeletons"><i></i><i></i><i></i></div>
		{:else if rawError}
			<div class="detail-error">Package detail unavailable. Counts are shown without a fabricated list.</div>
		{:else if raw?.packages.length}
			<div class="packages">
				{#each raw.packages as pkg (pkg.name)}
					<div>
						<code>{pkg.name}</code><span>{pkg.from ?? "?"} → {pkg.to ?? "?"}</span>{#if pkg.security}<b>security</b>{/if}
						{#if selected.applyMode === "staged-approval"}
							<OpButton def={approve} args={{ box_id: selected.boxId, packages: [pkg.name] }} lanes={u.lanes} label="Approve" />
						{/if}
					</div>
				{/each}
			</div>
		{:else}
			<p class="quiet">No package list is available for this host.</p>
		{/if}
		<div class="drawer-actions">
			{#if !selected.agentless && selected.applyMode === "staged-approval"}
				<OpButton def={approve} args={{ box_id: selected.boxId, packages: raw?.packages.map((p) => p.name) }} lanes={u.lanes} variant="primary" label={`Approve all ${raw?.packages.length ?? selected.pending ?? ""}`} />
			{/if}
			{#if !selected.agentless && (selected.applyMode === "auto" || selected.applyMode === "staged-approval")}
				<OpButton def={apply} args={{ box_id: selected.boxId }} lanes={u.lanes} executorLive={executorLive(selected)} />
			{:else if !selected.agentless && selected.applyMode === "manual-notify-only"}
				<OpButton def={notify} args={{ body: `Please review pending updates on ${selected.host}.`, needs: ["updates"] }} lanes={u.lanes} label={`Notify ${selected.host}`} />
			{:else if !selected.agentless && selected.applyMode === null}
				<span class="no-op">apply mode unknown · ask Janet before acting</span>
			{/if}
			{#if !selected.agentless && selected.rebootRequired === true}
				<OpButton def={reboot} args={{ box_id: selected.boxId, confirm_name: selected.boxId }} lanes={u.lanes} executorLive={executorLive(selected)} variant="danger" label={`Reboot ${selected.host}`} />
			{/if}
			{#if !selected.agentless}
				<OpButton def={check} args={{ box_id: selected.boxId }} lanes={u.lanes} executorLive={executorLive(selected)} variant="ghost" />
			{:else}
				<span class="no-op">notify only · no executor on this box</span>
			{/if}
		</div>
		{#if !selected.agentless && !executorLive(selected)}
			<p class="disabled-reason">box-agent executor is not answering</p>
		{/if}
	</dialog>
{/if}

{#if receiptOpen}
	<dialog bind:this={receiptEl} class="receipt" aria-labelledby="receipt-title" onclose={() => (receiptOpen = false)}>
		<button class="close" type="button" aria-label="Close query receipt" onclick={() => receiptEl?.close()}><Icon name="x" size={16} /></button>
		<h2 id="receipt-title">Query receipt</h2>
		<dl>
			<dt>Read</dt><dd><code>{dataMode() === "mock" ? "mock fixture · no network read" : "GET /api/v1/box-updates?limit=1000"}</code></dd>
			<dt>Source</dt><dd>{u.freshness?.source ?? "unavailable"}</dd>
			<dt>Observed</dt><dd>{u.freshness?.observedAt ?? "unavailable"}</dd>
			<dt>Rows</dt><dd>{u.rows.length}{u.truncated ? " (partial)" : ""}</dd>
			<dt>Fresh window</dt><dd>{u.freshness?.windowS == null ? "unknown" : `${u.freshness.windowS / 3600}h`}</dd>
		</dl>
	</dialog>
{/if}

<style>
	.hud { display: flex; gap: var(--s-2); margin-top: var(--s-3); flex-wrap: wrap; }
	.filter { display: flex; align-items: center; gap: var(--s-2); width: min(320px, 100%); min-height: 40px; margin-top: var(--s-3); padding: 0 var(--s-2); background: var(--s2); border-radius: var(--r-sm); color: var(--text-3); }
	.filter input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); font: 400 .8125rem var(--sans); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
	.board { margin-top: var(--s-4); background: var(--s1); border-radius: var(--r-xs); padding: 0 var(--s-2); overflow-x: auto; }
	.head { display: grid; grid-template-columns: 88px 150px 56px 64px 52px 64px 132px 64px 64px 1fr; gap: var(--s-2); min-width: 936px; padding: var(--s-2); font: 500 .6875rem var(--mono); text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); }
	.prov { display: flex; align-items: center; gap: var(--s-2); border-top: 1px solid var(--rule); padding: var(--s-2); font: 400 .6875rem var(--mono); color: var(--text-3); min-width: 936px; }
	.prov button { margin-inline-start: auto; border: 0; background: transparent; color: var(--petal-text); font: 500 .6875rem var(--sans); cursor: pointer; }
	.unverified, .empty { display: flex; flex-direction: column; align-items: center; gap: var(--s-2); text-align: center; padding: var(--s-6) var(--s-4); color: var(--text-3); }
	.unverified p, .empty p { font-size: .875rem; color: var(--text-2); max-width: 46ch; }
	.lower { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--s-3); margin-top: var(--s-3); }
	.crack { background: var(--danger-soft); color: var(--danger-text); border-radius: var(--r-xs); padding: var(--s-3); margin-top: var(--s-3); }
	.crack-title { display: flex; gap: var(--s-2); align-items: center; font-weight: 500; }
	.crack-meta, .crack p { margin-top: var(--s-1); font: 400 .75rem var(--mono); }
	.actions, .drawer-actions { display: flex; flex-wrap: wrap; gap: var(--s-2); align-items: center; margin-top: var(--s-3); }
	.cve, .containers > div, .packages > div { display: flex; align-items: center; gap: var(--s-2); min-height: 32px; border-top: 1px solid var(--rule); font-size: .75rem; }
	.cve:first-child, .containers > div:first-child, .packages > div:first-child { border-top: 0; }
	.severity { font: 500 .6875rem var(--mono); text-transform: uppercase; color: var(--text-3); }
	.severity.critical, .severity.high { color: var(--danger-text); }
	.severity.moderate { color: var(--warn-text); }
	.fixed, .containers span { margin-inline-start: auto; color: var(--text-3); }
	.containers time { font: 400 .6875rem var(--mono); color: var(--text-3); }
	.quiet, .detail-error { display: flex; align-items: center; gap: var(--s-2); min-height: 72px; color: var(--text-2); font-size: .75rem; }
	.detail-error { color: var(--danger-text); }
	.skeletons { display: grid; gap: var(--s-2); padding: var(--s-3) 0; }
	.skeletons i { display: block; height: 16px; width: 80%; background: var(--s2); border-radius: var(--r-xs); }
	.drawer { position: fixed; z-index: var(--z-dialog); inset: 0 0 0 auto; width: min(420px, 92vw); max-width: none; height: 100dvh; max-height: none; margin: 0; border: 0; background: var(--s1); color: var(--text); padding: var(--s-4); box-shadow: var(--shadow-pop); overflow-y: auto; animation: drawer-in var(--dur-mid) var(--ease-standard); }
	.drawer::backdrop, .receipt::backdrop { background: color-mix(in srgb, var(--text) 20%, transparent); }
	.close { border: 0; background: transparent; color: var(--text-2); width: 32px; height: 32px; display: grid; place-items: center; margin-inline-start: auto; cursor: pointer; }
	.drawer h2, .receipt h2 { font: 500 .875rem var(--sans); }
	.drawer-meta, .disabled-reason, .no-op { color: var(--text-3); font: 400 .75rem var(--mono); margin-top: var(--s-1); }
	.packages { margin-top: var(--s-4); }
	.packages span { margin-inline-start: auto; font: 400 .75rem var(--mono); color: var(--text-3); }
	.packages b { color: var(--danger-text); font: 500 .6875rem var(--mono); }
	.receipt { position: fixed; z-index: var(--z-dialog); inset: 50% auto auto 50%; transform: translate(-50%, -50%); width: min(520px, 90vw); background: var(--s1); color: var(--text); border: 0; border-radius: var(--r-lg); padding: var(--s-4); box-shadow: var(--shadow-pop); }
	.receipt dl { display: grid; grid-template-columns: 112px 1fr; gap: var(--s-2) var(--s-3); margin-top: var(--s-3); }
	.receipt dt { color: var(--text-3); }
	.receipt dd { min-width: 0; overflow-wrap: anywhere; }
	@keyframes drawer-in { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
	@media (max-width: 767px) {
		.board { background: transparent; padding: 0; overflow: visible; }
		.head { display: none; }
		.board :global(.row) { grid-template-columns: 72px 1fr 64px; min-width: 0; height: 48px; background: var(--s1); margin-top: 1px; }
		.board :global(.row > :not(.host):not(.pill):not(.sec)) { display: none; }
		.prov { min-width: 0; }
		.lower { display: none; }
	}
	@media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
</style>
