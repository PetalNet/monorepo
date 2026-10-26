<script lang="ts">
	import Bot from "@lucide/svelte/icons/bot";
	import Sparkles from "@lucide/svelte/icons/sparkles";

	import type { UsageReadout } from "$lib/server/dossier";

	import Card from "./Card.svelte";
	import MeterBar from "./MeterBar.svelte";
	import StatusPill from "./StatusPill.svelte";

	let { agent, now }: { agent: UsageReadout; now: number } = $props();
	const resetIn = (epoch: number | null): string | null => {
		if (epoch === null) return null;
		const minutes = Math.max(0, Math.ceil((epoch * 1000 - now) / 60_000));
		if (minutes < 60) return `in ${minutes}m`;
		return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	};
	const credits = $derived(agent.creditsBalance === null ? "No reading" : new Intl.NumberFormat().format(agent.creditsBalance));
</script>

<Card title={agent.label} icon={agent.kind === "claude" ? Sparkles : Bot}>
	{#snippet status()}
		{#if agent.awaiting}
			<StatusPill label="Awaiting" />
		{:else if agent.stale}
			<StatusPill label="Stale" tone="warn" />
		{/if}
	{/snippet}
	<div class="agent-content">
		<div class:two-meters={agent.kind === "claude"} class="meters">
			{#if agent.kind === "claude"}
				<MeterBar label="5h window" value={agent.fiveHourPct} reset={resetIn(agent.fiveHourResetsAt)} />
			{/if}
			<MeterBar label="7d window" value={agent.sevenDayPct} reset={resetIn(agent.sevenDayResetsAt)} />
		</div>
		{#if agent.kind === "codex"}
			<div class="credits"><span>Credits balance</span><strong class="mono">{credits}</strong></div>
		{/if}
	</div>
</Card>
