<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import Card from "$lib/components/Card.svelte";
	import Orloj from "$lib/components/Orloj.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";
	import ThemeToggle from "$lib/components/ThemeToggle.svelte";
	import { servicesSummary } from "$lib/services";
	import Cloud from "@lucide/svelte/icons/cloud";
	import Cpu from "@lucide/svelte/icons/cpu";
	import Frown from "@lucide/svelte/icons/frown";
	import Meh from "@lucide/svelte/icons/meh";
	import Server from "@lucide/svelte/icons/server";
	import Smile from "@lucide/svelte/icons/smile";
	import { onMount } from "svelte";

	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();

	const services = $derived(servicesSummary(data.dossier.services));

	const dateTime = (value: number | null): string =>
		value === null
			? "Awaiting data"
			: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
					value,
				);
	const relative = (value: number | null, now: number): string => {
		if (value === null) {
			return "Awaiting data";
		}

		const minutes = Math.round(Math.abs(now - value) / 60_000);

		if (minutes < 1) {
			return "just now";
		}

		if (minutes < 60) {
			return `${String(minutes)}m ago`;
		}

		if (minutes < 1_440) {
			return `${String(Math.floor(minutes / 60))}h ago`;
		}

		return `${String(Math.floor(minutes / 1_440))}d ago`;
	};
	const moodIcon = (mood: string) =>
		/sad|low|tired|bad/i.test(mood) ? Frown : /calm|quiet|neutral|fine/i.test(mood) ? Meh : Smile;

	onMount(() => {
		const interval = window.setInterval(() => void invalidateAll(), 30_000);

		return () => {
			window.clearInterval(interval);
		};
	});
</script>

<svelte:head
	><title>Astrolabe</title><meta name="description" content="Lab status dashboard" /></svelte:head
>

<header class="top">
	<div class="top-inner">
		<h1>Astrolabe</h1>
		<ThemeToggle />
	</div>
</header>

<main class="wrap">
	<Orloj dossier={data.dossier} />

	<section class="dashboard-grid" aria-label="Lab systems">
		<Card title="Backup" icon={Cloud}>
			{#snippet status()}{#if data.dossier.backup.stale}<StatusPill
						label="Stale"
						tone="warn"
					/>{/if}{/snippet}
			<div class="detail-list">
				<div>
					<span>Last success</span><strong
						>{relative(data.dossier.backup.lastSuccessAt, data.dossier.now)}</strong
					>
				</div>
				<div>
					<span>Next scheduled</span><strong>{dateTime(data.dossier.backup.nextScheduledAt)}</strong
					>
				</div>
			</div>
		</Card>

		<Card title="Services" icon={Server}>
			{#snippet status()}<StatusPill
					label={services.pill.label}
					tone={services.pill.tone}
				/>{/snippet}
			<dl class="stats-row">
				{#each services.stats as stat (stat.label)}
					<div class:alert={stat.alert}>
						<dt>{stat.label}</dt>
						<dd class="mono">{stat.count}</dd>
					</div>
				{/each}
			</dl>
			{#if services.recent}<p class="state-copy">
					<span class="sdot down"></span>{services.recent}
				</p>
			{:else}<p class="state-copy">All caught up.</p>{/if}
		</Card>

		<Card title="Host" icon={Cpu}>
			{#snippet status()}{#if data.dossier.host.stale}<StatusPill
						label="Stale"
						tone="warn"
					/>{/if}{/snippet}
			<div class="detail-list compact">
				<div>
					<span>Disk</span><strong
						>{data.dossier.host.diskWorst
							? `${data.dossier.host.diskWorst.mount} · ${data.dossier.host.diskWorst.level}`
							: "All caught up."}</strong
					>
				</div>
				<div><span>Load</span><strong class="mono">{data.dossier.host.load}</strong></div>
				<div><span>Swap</span><strong class="mono">{data.dossier.host.swap}</strong></div>
			</div>
			{#if data.dossier.host.containerFails.length > 0}<p class="fail-list">
					<span class="sdot down"></span>{data.dossier.host.containerFails.join(", ")}
				</p>{/if}
		</Card>

		<Card title="Mood" icon={moodIcon(data.dossier.mood.mood)}>
			<div class="mood">
				<strong>{data.dossier.mood.mood}</strong>
				<p>“{data.dossier.mood.quote}”</p>
			</div>
		</Card>
	</section>
</main>
