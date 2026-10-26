<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import Cloud from "@lucide/svelte/icons/cloud";
	import Cpu from "@lucide/svelte/icons/cpu";
	import Frown from "@lucide/svelte/icons/frown";
	import Meh from "@lucide/svelte/icons/meh";
	import Moon from "@lucide/svelte/icons/moon";
	import Server from "@lucide/svelte/icons/server";
	import Smile from "@lucide/svelte/icons/smile";
	import Sun from "@lucide/svelte/icons/sun";
	import Sunrise from "@lucide/svelte/icons/sunrise";
	import Sunset from "@lucide/svelte/icons/sunset";
	import { onMount } from "svelte";

	import AgentCard from "$lib/components/AgentCard.svelte";
	import Card from "$lib/components/Card.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";
	import ThemeToggle from "$lib/components/ThemeToggle.svelte";

	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();

	const dateTime = (value: number | null): string => value === null ? "Awaiting data" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
	const clockTime = (value: number): string => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
	const relative = (value: number | null, now: number): string => {
		if (value === null) return "Awaiting data";
		const minutes = Math.round(Math.abs(now - value) / 60_000);
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
		return `${Math.floor(minutes / 1_440)}d ago`;
	};
	const nextSunLabel = (nextEvent: { at: number | null; kind: "sunrise" | "sunset" | null }, now: number): string => {
		if (nextEvent.at === null || nextEvent.kind === null) return "No sky reading";
		const minutes = Math.max(0, Math.round((nextEvent.at - now) / 60_000));
		return `${nextEvent.kind === "sunrise" ? "Sunrise" : "Sunset"} in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	};
	const titleCase = (value: string): string => value.slice(0, 1).toUpperCase() + value.slice(1);
	const moodIcon = (mood: string) => /sad|low|tired|bad/i.test(mood) ? Frown : /calm|quiet|neutral|fine/i.test(mood) ? Meh : Smile;

	onMount(() => {
		const interval = window.setInterval(() => void invalidateAll(), 30_000);
		return () => window.clearInterval(interval);
	});
</script>

<svelte:head><title>Astrolabe</title><meta name="description" content="Lab status dashboard" /></svelte:head>

<header class="top">
	<div class="top-inner">
		<div><h1>Astrolabe</h1><p class="current-time mono">{clockTime(data.dossier.now)}</p></div>
		<ThemeToggle />
	</div>
</header>

<main class="wrap">
	<section class="sky-strip" aria-label="Sky conditions">
		<div class="sky-reading"><Sun size={21} strokeWidth={1.7} /><div><span class="sky-label">Sun</span><strong>{titleCase(data.dossier.sun.phase)}</strong><p>{nextSunLabel(data.dossier.sun.nextEvent, data.dossier.now)}</p></div></div>
		<div class="sky-reading"><Moon size={21} strokeWidth={1.7} /><div><span class="sky-label">Moon</span><strong>{data.dossier.moon.phaseName}</strong><p class="mono">{Math.round(data.dossier.moon.illumination * 100)}% illuminated</p></div></div>
	</section>

	<section class="section-block" aria-labelledby="agents-heading">
		<div class="section-heading"><h2 id="agents-heading">Agents</h2><p>Usage windows and balance</p></div>
		<div class="agent-grid">
			{#each data.dossier.agents as agent (agent.slug)}
				<AgentCard {agent} now={data.dossier.now} />
			{/each}
		</div>
	</section>

	<section class="dashboard-grid" aria-label="Lab systems">
		<Card title="Backup" icon={Cloud}>
			{#snippet status()}{#if data.dossier.backup.stale}<StatusPill label="Stale" tone="warn" />{/if}{/snippet}
			<div class="detail-list">
				<div><span>Last success</span><strong>{relative(data.dossier.backup.lastSuccessAt, data.dossier.now)}</strong></div>
				<div><span>Next scheduled</span><strong>{dateTime(data.dossier.backup.nextScheduledAt)}</strong></div>
			</div>
		</Card>

		<Card title="Services" icon={Server}>
			{#snippet status()}
				{#if data.dossier.services.stale}<StatusPill label="Stale" tone="warn" />
				{:else if data.dossier.services.down > 0}<StatusPill label="Needs attention" tone="down" />
				{:else}<StatusPill label="Healthy" tone="ok" />{/if}
			{/snippet}
			<div class="stats-row"><div><strong class="mono">{data.dossier.services.up}</strong><span>up</span></div><div><strong class="mono">{data.dossier.services.down}</strong><span>down</span></div><div><strong class="mono">{data.dossier.services.pending}</strong><span>pending</span></div></div>
			{#if data.dossier.services.recentDownEvents1h > 0}<p class="state-copy"><span class="sdot down"></span>{data.dossier.services.recentDownEvents1h} down in the last hour</p>{:else}<p class="state-copy">All caught up.</p>{/if}
		</Card>

		<Card title="Host" icon={Cpu}>
			{#snippet status()}{#if data.dossier.host.stale}<StatusPill label="Stale" tone="warn" />{/if}{/snippet}
			<div class="detail-list compact">
				<div><span>Disk</span><strong>{data.dossier.host.diskWorst ? `${data.dossier.host.diskWorst.mount} · ${data.dossier.host.diskWorst.level}` : "All caught up."}</strong></div>
				<div><span>Load</span><strong class="mono">{data.dossier.host.load}</strong></div>
				<div><span>Swap</span><strong class="mono">{data.dossier.host.swap}</strong></div>
			</div>
			{#if data.dossier.host.containerFails.length > 0}<p class="fail-list"><span class="sdot down"></span>{data.dossier.host.containerFails.join(", ")}</p>{/if}
		</Card>

		<Card title="Mood" icon={moodIcon(data.dossier.mood.mood)}>
			<div class="mood"><strong>{data.dossier.mood.mood}</strong><p>“{data.dossier.mood.quote}”</p></div>
		</Card>
	</section>
</main>
