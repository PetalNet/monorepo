<script lang="ts">
	import HudChip from "$lib/components/HudChip.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import SurfaceSign from "$lib/components/SurfaceSign.svelte";
	import UpdateRow from "$lib/components/UpdateRow.svelte";

	let { data } = $props();
	const u = $derived(data.updates);
	const critical = $derived(u.hud.securityCritical > 0);
</script>

<SurfaceSign
	title="Updates"
	verdict={!u.connected
		? "cant_verify"
		: critical
			? "cracked"
			: u.securityUnknown || u.remainder
				? "needs_you"
				: "fine"}
	stateFact={critical
		? `${u.hud.securityCritical} security-critical update${u.hud.securityCritical === 1 ? "" : "s"} pending.`
		: u.securityUnknown
			? `Nothing known critical.${u.remainder ? ` ${u.remainder}.` : ""}`
			: u.remainder
				? `Nothing critical. ${u.remainder}.`
				: "Nothing critical."}
/>

{#if !u.connected}
	<div class="unverified">
		<Icon name="circle-help" size={20} />
		<p>Can't verify update state yet. The /box-updates read lands with the backend's 2nd pass.</p>
	</div>
{:else}
	<div class="hud">
		<HudChip tone={critical ? "danger" : "idle"} count={u.hud.securityCritical} label="security-critical" />
		<HudChip tone="idle" count={u.hud.owing} label="owe updates" />
		<HudChip tone="idle" count={u.hud.reboots} label="reboots pending" />
	</div>

	<div class="board">
		<div class="head">
			<span>host</span><span>status</span><span>pending</span><span>security</span><span>vulns</span>
			<span>reboot</span><span>mode</span><span>checked</span><span>applied</span><span>source</span>
		</div>
		{#each u.rows as row (row.boxId)}
			<UpdateRow {row} />
		{/each}
		<div class="prov">
			<Icon name="receipt-text" size={12} />
			<span>box_update_status · {u.rows.length} boxes</span>
			<a href="#show-the-math" onclick={(e) => e.preventDefault()}>Show the math.</a>
		</div>
	</div>
{/if}

<style>
	.hud {
		display: flex;
		gap: var(--s-2);
		margin-top: var(--s-3);
		flex-wrap: wrap;
	}
	.board {
		margin-top: var(--s-4);
		background: var(--s1);
		border-radius: var(--r-xs);
		padding: 0 var(--s-2);
		overflow-x: auto;
	}
	.head {
		display: grid;
		grid-template-columns: 88px 150px 56px 64px 52px 64px 132px 64px 64px 1fr;
		gap: var(--s-2);
		padding: var(--s-2);
		font:
			500 0.6875rem var(--mono);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-3);
	}
	.prov {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		border-top: 1px solid var(--rule);
		padding: var(--s-2);
		font:
			400 0.6875rem var(--mono);
		color: var(--text-3);
	}
	.prov a {
		color: var(--petal-text);
		text-decoration: none;
		margin-inline-start: auto;
		font-weight: 500;
	}
	.unverified {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--s-2);
		text-align: center;
		padding: var(--s-6) var(--s-4);
		color: var(--text-3);
	}
	.unverified :global(svg) {
		color: var(--warn-dot);
	}
	.unverified p {
		font-size: 0.875rem;
		color: var(--text-2);
		max-width: 46ch;
	}
</style>
