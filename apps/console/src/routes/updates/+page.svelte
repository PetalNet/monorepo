<script lang="ts">
	import { onMount } from "svelte";

	import { connectBus, dataMode, readBoxUpdateRaw, readHealth, runQuery } from "$lib/api/client";
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
	import {
		approveUpdate,
		getUpdateApprovals,
		revokeUpdateApproval,
		type UpdateApproval,
	} from "./approvals.remote";

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
	type ContainerUpdate = {
		id: string;
		container: string;
		source: string;
		at: string;
	};
	let containerUpdates = $state<ContainerUpdate[]>(
		dataMode() === "mock"
			? [
					{ id: "mock-1", container: "citeseer-web", source: ".14 · 1.8.2 → 1.9.0", at: new Date(Date.now() - 2 * 3_600_000).toISOString() },
					{ id: "mock-2", container: "tasks-app", source: ".202 · ab12f → 9c04e", at: new Date(Date.now() - 5 * 3_600_000).toISOString() },
					{ id: "mock-3", container: "matrix-bridge", source: ".12 · 0.4.1 → 0.4.3", at: new Date(Date.now() - 9 * 3_600_000).toISOString() },
				]
			: [],
	);
	let containerHistory = $state<"loading" | "ready" | "unavailable">(
		dataMode() === "mock" ? "ready" : "loading",
	);
	let containerObservedAt = $state<string | null>(null);
	let containerQueryRef = $state<string | null>(null);
	let containerLiveAt = $state<string | null>(null);
	let containerLastSeq = $state<number | undefined>(undefined);
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
	const apply = opDef("updates.apply")!;
	const check = opDef("updates.check")!;
	const notify = opDef("task.dispatch")!;
	const reboot = opDef("host.reboot")!;
	let drawerEl = $state<HTMLDialogElement | null>(null);
	let receiptEl = $state<HTMLDialogElement | null>(null);
	let approvals = $state<UpdateApproval[]>([]);
	let approvalsLoading = $state(false);
	let approvalError = $state<string | null>(null);
	let approvalBusy = $state<string | null>(null);
	let approvalLoad = 0;
	const canOperate = $derived(u.lanes.includes("operator"));
	const unapprovedPackages = $derived(
		(raw?.packages ?? []).filter((pkg) => !approvalFor(pkg.name)).map((pkg) => pkg.name),
	);

	function recordRows(result: Awaited<ReturnType<typeof runQuery>>): Record<string, unknown>[] {
		return result.rows.map((row) =>
			Object.fromEntries(result.columns.map((column, index) => [column.name, row[index]])),
		);
	}

	function asContainerUpdate(row: Record<string, unknown>): ContainerUpdate {
		const seq = Number(row["seq"]);
		const at = typeof row["ts"] === "string" ? row["ts"] : new Date().toISOString();
		return {
			id: Number.isFinite(seq) ? String(seq) : `${String(row["subject"])}:${at}`,
			container: String(row["claimed_container"] ?? row["subject"] ?? "unknown container"),
			source: String(row["source_agent"] ?? row["source_host"] ?? "source unknown"),
			at,
		};
	}

	async function loadContainerHistory() {
		try {
			const result = await runQuery({
				schema_version: 1,
				mode: "structured",
				from: "container.update_available",
				select: [
					{ field: "seq" },
					{ field: "claimed_container" },
					{ field: "subject" },
					{ field: "source.agent" },
					{ field: "source.host" },
					{ field: "ts" },
				],
				time: { from: new Date(Date.now() - 7 * 86_400_000).toISOString() },
				order: [{ field: "ts", dir: "desc" }],
				limit: 6,
			});
			const rows = recordRows(result);
			containerUpdates = rows.map(asContainerUpdate);
			containerLastSeq = Math.max(0, ...rows.map((row) => Number(row["seq"]) || 0)) || undefined;
			containerObservedAt = result.freshness.observed_at;
			containerQueryRef = result.query_ref;
			containerLiveAt = null;
			containerHistory = "ready";
		} catch {
			containerHistory = "unavailable";
		}
	}

	onMount(() => {
		if (dataMode() === "mock") return;
		let disposed = false;
		let disconnect: (() => void) | null = null;
		void (async () => {
			const recoveryHead = await readHealth().then((health) => health.seq_head).catch(() => null);
			await loadContainerHistory();
			if (disposed) return;
			disconnect = connectBus(
				() => [
					{
						sub_id: "console-updates-containers",
						pattern: "container.update_available",
						since: recoveryHead ?? containerLastSeq ?? 0,
					},
					{
						sub_id: "console-updates-approval-state",
						pattern: "box.update_status_changed",
						since: recoveryHead ?? 0,
					},
				],
				(rawFrame) => {
					const frame = rawFrame as {
						kind?: string;
						seq?: number;
						emission?: {
							type?: string;
							subject?: string;
							ts?: string;
							source?: { agent?: string | null; host?: string | null };
							dimensions?: Record<string, string | boolean>;
						};
					};
					const changedBoxId = frame.emission?.subject;
					if (frame.kind === "event" && frame.emission?.type === "container.update_available") {
						const update = asContainerUpdate({
							seq: frame.seq,
							claimed_container: frame.emission.dimensions?.["claimed_container"],
							subject: frame.emission.subject,
							source_agent: frame.emission.source?.agent,
							source_host: frame.emission.source?.host,
							ts: frame.emission.ts,
						});
						containerUpdates = [
							update,
							...containerUpdates.filter((item) => item.id !== update.id),
						].slice(0, 6);
						containerLastSeq = frame.seq ?? containerLastSeq;
						containerLiveAt = update.at;
						containerHistory = "ready";
					}
					if (
						frame.kind === "event" &&
						frame.emission?.type === "box.update_status_changed" &&
						typeof changedBoxId === "string" &&
						selected?.boxId === changedBoxId
					)
						void loadApprovals(changedBoxId);
					if (frame.kind === "gap" || frame.kind === "resync_required") {
						void loadContainerHistory();
						if (selected) void loadApprovals(selected.boxId);
					}
				},
			);
		})();
		return () => {
			disposed = true;
			disconnect?.();
		};
	});

	$effect(() => {
		if (receiptOpen && receiptEl && !receiptEl.open) receiptEl.showModal();
	});
	$effect(() => {
		const boxId = selected?.boxId;
		if (!boxId) {
			approvalLoad += 1;
			approvals = [];
			approvalsLoading = false;
			approvalError = null;
			return;
		}
		void loadApprovals(boxId);
	});

	async function loadApprovals(boxId: string) {
		const request = ++approvalLoad;
		approvalsLoading = true;
		approvalError = null;
		try {
			const next = await getUpdateApprovals({ box_id: boxId });
			if (request === approvalLoad && selected?.boxId === boxId) approvals = next;
		} catch (error) {
			if (request === approvalLoad && selected?.boxId === boxId)
				approvalError = (error as Error).message || "Approvals could not be read.";
		} finally {
			if (request === approvalLoad && selected?.boxId === boxId) approvalsLoading = false;
		}
	}

	function approvalFor(packageName: string): UpdateApproval | undefined {
		return approvals.find(
			(approval) => approval.packages.length === 0 || approval.packages.includes(packageName),
		);
	}

	async function approvePackages(packages: string[]) {
		if (!selected || approvalBusy) return;
		approvalBusy = `approve:${packages.join(",") || "all"}`;
		approvalError = null;
		try {
			const boxId = selected.boxId;
			const approved = await approveUpdate({ box_id: boxId, packages });
			await loadApprovals(boxId);
			const undoAction = async () => {
				try {
					await revokeUpdateApproval({
						approval_id: approved.approval.approval_id,
						box_id: boxId,
					});
				} finally {
					if (selected?.boxId === boxId) await loadApprovals(boxId);
				}
			};
			snackbar.push({
				message: "updates.approve recorded · rollout remains pending",
				op: "updates.approve",
				tone: "good",
				...(approved.approval.revocable ? { undo: approved.undo, onUndo: undoAction } : {}),
			});
		} catch (error) {
			approvalError = (error as Error).message || "Approval could not be recorded.";
		} finally {
			approvalBusy = null;
		}
	}

	async function revokeApproval(approval: UpdateApproval) {
		if (!selected || approvalBusy) return;
		approvalBusy = `revoke:${approval.approval_id}`;
		approvalError = null;
		try {
			await revokeUpdateApproval({ approval_id: approval.approval_id, box_id: selected.boxId });
			snackbar.push({ message: "updates.revoke applied · approval returned to pending", op: "updates.revoke", tone: "good" });
		} catch (error) {
			approvalError = (error as Error).message || "Approval could not be revoked.";
		} finally {
			if (selected) await loadApprovals(selected.boxId);
			approvalBusy = null;
		}
	}

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
		if (drawerEl && !drawerEl.open) drawerEl.showModal();
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
					{#if canOperate}<button class="approval-btn primary" disabled={approvalBusy !== null || approvalsLoading || unapprovedPackages.length === 0} onclick={() => approvePackages(unapprovedPackages)}>{approvalBusy?.startsWith("approve:") ? "Approving" : "Approve pending"}</button>{/if}
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
			prov={{ source: containerLiveAt ? containerQueryRef ? `${containerQueryRef} + live bus` : "live bus" : containerQueryRef ?? "container.update_available", freshness: dataMode() === "mock" ? "mock live" : containerLiveAt ?? containerObservedAt ?? containerHistory, rows: containerHistory === "ready" ? `${containerUpdates.length} updates` : null }}
		>
			{#if containerUpdates.length}
				<div class="containers">
					{#each containerUpdates as update (update.id)}
						<div><code>{update.container}</code><span>{update.source} · update available</span><time>{Math.max(0, Math.round((Date.now() - Date.parse(update.at)) / 3_600_000))}h</time></div>
					{/each}
				</div>
			{:else if containerHistory === "loading"}
				<div class="skeletons" aria-label="Loading container update history"><i></i><i></i><i></i></div>
			{:else if containerHistory === "ready"}
				<div class="quiet"><Icon name="shield-check" size={14} /> No container updates arrived in the last 7 days.</div>
			{:else}
				<div class="quiet"><Icon name="circle-help" size={14} /> Container history query failed. No live-only state is shown.</div>
			{/if}
		</Panel>
	</div>
{/if}

	<dialog
		bind:this={drawerEl}
		class="approval-drawer"
		aria-label={selected ? `Update detail for ${selected.host}` : "Update detail"}
		onclose={() => (selected = null)}
	>
	{#if selected}
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
							{#if approvalFor(pkg.name)}
								<span class="approved-state"><Icon name="circle-check" size={13} /> approved</span>
							{:else if canOperate}
								<button class="approval-btn quiet-action" disabled={approvalBusy !== null || approvalsLoading} onclick={() => approvePackages([pkg.name])}>{approvalBusy === `approve:${pkg.name}` ? "Approving" : "Approve"}</button>
							{/if}
						{/if}
					</div>
				{/each}
			</div>
		{:else}
			<p class="quiet">No package list is available for this host.</p>
		{/if}
		{#if selected.applyMode === "staged-approval" && approvals.length}
			<section class="approval-ledger" aria-label="Unapplied approvals">
				<div class="ledger-head"><span>Approved, awaiting rollout</span><small>{approvals.length} active</small></div>
				{#each approvals as approval (approval.approval_id)}
					<div class="approval-entry">
						<div>
							<strong>{approval.packages.length ? approval.packages.join(", ") : "All pending updates"}</strong>
							<span>{approval.approved_by} · {new Date(approval.approved_at).toLocaleString()}</span>
						</div>
						{#if canOperate && approval.revocable}<button class="approval-btn revoke" disabled={approvalBusy !== null} onclick={() => revokeApproval(approval)}>{approvalBusy === `revoke:${approval.approval_id}` ? "Revoking" : "Revoke approval"}</button>{/if}
					</div>
				{/each}
				<p>Revocation is available only until rollout begins.</p>
			</section>
		{/if}
		{#if approvalError}<p class="approval-error" role="alert"><Icon name="circle-alert" size={13} /> {approvalError}</p>{/if}
		<div class="drawer-actions">
			{#if !selected.agentless && selected.applyMode === "staged-approval"}
				{#if canOperate && unapprovedPackages.length}
					<button class="approval-btn primary" disabled={approvalBusy !== null || approvalsLoading} onclick={() => approvePackages(unapprovedPackages)}>{approvalBusy?.startsWith("approve:") ? "Approving" : `Approve ${unapprovedPackages.length ? `remaining ${unapprovedPackages.length}` : `all ${selected.pending ?? ""}`}`}</button>
				{/if}
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
	{/if}
	</dialog>

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
	.approval-drawer { position: fixed; z-index: var(--z-dialog); inset: 0 0 0 auto; width: min(420px, 92vw); max-width: none; height: 100dvh; max-height: none; margin: 0; border: 0; background: var(--s1); color: var(--text); padding: var(--s-4); box-shadow: var(--shadow-pop); overflow-y: auto; animation: drawer-in var(--dur-mid) var(--ease-standard); }
	.approval-drawer::backdrop, .receipt::backdrop { background: color-mix(in srgb, var(--text) 20%, transparent); }
	.close { border: 0; background: transparent; color: var(--text-2); width: 32px; height: 32px; display: grid; place-items: center; margin-inline-start: auto; cursor: pointer; }
	.approval-drawer h2, .receipt h2 { font: 500 .875rem var(--sans); }
	.drawer-meta, .disabled-reason, .no-op { color: var(--text-3); font: 400 .75rem var(--mono); margin-top: var(--s-1); }
	.packages { margin-top: var(--s-4); }
	.packages span { margin-inline-start: auto; font: 400 .75rem var(--mono); color: var(--text-3); }
	.packages b { color: var(--danger-text); font: 500 .6875rem var(--mono); }
	.approved-state { display: inline-flex; align-items: center; gap: var(--s-1); color: var(--good-text) !important; font-weight: 500 !important; }
	.approval-ledger { margin-top: var(--s-4); background: var(--s2); border-radius: var(--r-xs); padding: var(--s-2) var(--s-3); animation: approval-change var(--dur-mid) var(--ease-standard); }
	.ledger-head, .approval-entry { display: flex; align-items: center; gap: var(--s-2); }
	.ledger-head { min-height: 32px; color: var(--text-2); font-size: .75rem; font-weight: 500; }
	.ledger-head small { margin-inline-start: auto; color: var(--text-3); font: 400 .6875rem var(--mono); }
	.approval-entry { min-height: 48px; border-top: 1px solid var(--rule); }
	.approval-entry > div { min-width: 0; display: grid; gap: 2px; }
	.approval-entry strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font: 500 .75rem var(--mono); }
	.approval-entry span, .approval-ledger > p { color: var(--text-3); font: 400 .6875rem var(--mono); }
	.approval-ledger > p { border-top: 1px solid var(--rule); padding-top: var(--s-2); }
	.approval-btn { min-height: 32px; border: 0; border-radius: var(--r-sm); padding: var(--s-1) var(--s-2); background: var(--petal-soft); color: var(--petal-text); cursor: pointer; font: 500 .75rem var(--sans); transition: background var(--t), transform var(--dur-fast) var(--ease-standard), opacity var(--t); }
	.approval-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--petal) 20%, transparent); }
	.approval-btn:active:not(:disabled) { transform: scale(.97); }
	.approval-btn:disabled { cursor: wait; opacity: .52; }
	.approval-btn.primary { min-height: 40px; padding-inline: var(--s-3); background: var(--petal-fill); color: var(--on-petal); }
	.approval-btn.revoke { flex: none; margin-inline-start: auto; background: transparent; }
	.approval-btn.quiet-action { margin-inline-start: 0; flex: none; }
	.approval-error { display: flex; align-items: center; gap: var(--s-1); margin-top: var(--s-2); color: var(--danger-text); font: 400 .75rem var(--mono); }
	.receipt { position: fixed; z-index: var(--z-dialog); inset: 50% auto auto 50%; transform: translate(-50%, -50%); width: min(520px, 90vw); background: var(--s1); color: var(--text); border: 0; border-radius: var(--r-lg); padding: var(--s-4); box-shadow: var(--shadow-pop); }
	.receipt dl { display: grid; grid-template-columns: 112px 1fr; gap: var(--s-2) var(--s-3); margin-top: var(--s-3); }
	.receipt dt { color: var(--text-3); }
	.receipt dd { min-width: 0; overflow-wrap: anywhere; }
	@keyframes drawer-in { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
	@keyframes approval-change { from { opacity: .72; transform: translateY(2px); } to { opacity: 1; transform: none; } }
	@media (max-width: 767px) {
		.board { background: transparent; padding: 0; overflow: visible; }
		.head { display: none; }
		.board :global(.row) { grid-template-columns: 72px 1fr 64px; min-width: 0; height: 48px; background: var(--s1); margin-top: 1px; }
		.board :global(.row > :not(.host):not(.pill):not(.sec)) { display: none; }
		.prov { min-width: 0; }
		.lower { display: none; }
	}
	@media (prefers-reduced-motion: reduce) { .approval-drawer, .approval-ledger { animation: none; } }
</style>
