<script lang="ts">
	import type { HostView } from "$lib/data/hosts";
	import Icon from "./Icon.svelte";
	import StatusDot from "./StatusDot.svelte";
	import StatusPill from "./StatusPill.svelte";

	/**
	 * HostCard (07-hosts §3.1): a host as a house. Roof band is jade — the place
	 * charter (foundations §3 lists "the neighborhood" as a jade use); health never
	 * recolors the roof, it shows in the liveness dot + tick line. Lit windows =
	 * active workers. Clickable to the host drill.
	 */
	interface Props {
		host: HostView;
		highlighted?: boolean;
	}
	let { host, highlighted = false }: Props = $props();

	const tone = $derived(
		host.liveness === "down" ? "danger" : host.liveness === "degraded" ? "warn" : "good",
	);
	// Windows represent RESIDENTS, lit for the active workers among them (capped);
	// container count lives in the meter text, not the window row.
	const windows = $derived(
		Array.from({ length: Math.min(host.residents.length, 12) }, (_, i) => i < host.workersUp),
	);
</script>

<a class="house" class:highlighted href="/hosts?host={host.host}" aria-label="Host {host.host}">
	<div class="roof"></div>
	<div class="pad">
		<div class="body">
			{#each windows.slice(0, 12) as on, i (i)}
				<span class="win" class:on></span>
			{/each}
		</div>
		<div class="name">
			<StatusDot {tone} size={6} />
			<b>{host.host}</b>
			{#if host.rebootRequired}<Icon name="shield-check" size={12} />{/if}
		</div>
		<div class="phone-status"><StatusPill {tone} label={host.liveness} /></div>
		<div class="occ">
			{host.residents.length} resident{host.residents.length === 1 ? "" : "s"} · {host.containers ?? "—"} containers
		</div>
		<div class="tick" class:warn={host.updateStatus !== "up_to_date"}>
			{#if (host.securityCritical ?? 0) > 0}
				{host.securityCritical} security-critical
			{:else if host.updateStatus === "updates_overdue"}
				updates overdue
			{:else if host.updateStatus === "updates_pending"}
				updates pending
			{:else if host.updateStatus === "error_collecting"}
				can't collect updates
			{:else if host.updateStatus === null}
				update posture unavailable
			{:else}
				up to date
			{/if}
		</div>
	</div>
</a>

<style>
	.house {
		display: block;
		background: var(--s1);
		border-radius: var(--r-xs);
		overflow: hidden;
		text-decoration: none;
		color: inherit;
		transition: background var(--t);
	}
	.house:hover {
		background: var(--s2);
	}
	.house.highlighted {
		box-shadow: 0 0 0 2px var(--petal);
	}
	.roof {
		height: 6px;
		background: var(--jade);
		opacity: 0.55;
	}
	.pad {
		padding: var(--s-3);
	}
	.body {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		min-height: 20px;
		margin-bottom: var(--s-2);
	}
	.win {
		width: 8px;
		height: 12px;
		border-radius: var(--r-xs);
		background: var(--s3);
	}
	.win.on {
		background: var(--lit);
	}
	.name {
		display: flex;
		align-items: center;
		gap: var(--s-1);
	}
	.name b {
		font:
			500 0.8125rem var(--mono);
	}
	.name :global(svg) {
		color: var(--warn-dot);
		margin-inline-start: auto;
	}
	.occ {
		font:
			400 0.6875rem var(--mono);
		color: var(--text-3);
		margin-top: 2px;
	}
	.tick {
		font:
			400 0.6875rem var(--mono);
		color: var(--text-3);
		margin-top: var(--s-1);
	}
	.tick.warn {
		color: var(--warn-text);
	}
	.phone-status {
		display: none;
	}
	@media (max-width: 767px) {
		.house {
			height: 48px;
			overflow: visible;
		}
		.roof,
		.body {
			display: none;
		}
		.pad {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-rows: 24px 16px;
			column-gap: var(--s-2);
			height: 48px;
			padding: var(--s-1) var(--s-2);
		}
		.name {
			grid-column: 1;
			grid-row: 1;
			min-width: 0;
		}
		.name > :global(.dot) {
			display: none;
		}
		.name b {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.name :global(svg) {
			margin-inline-start: 0;
		}
		.phone-status {
			display: block;
			grid-column: 2;
			grid-row: 1;
		}
		.occ,
		.tick {
			align-self: start;
			margin-top: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.occ {
			grid-column: 1;
			grid-row: 2;
		}
		.tick {
			grid-column: 2;
			grid-row: 2;
			text-align: end;
		}
	}
</style>
