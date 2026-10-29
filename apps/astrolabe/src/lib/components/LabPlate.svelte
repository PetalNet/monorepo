<script lang="ts">
	import type { Dossier } from "$lib/server/dossier";
	import { servicesSummary } from "$lib/services";

	let { dossier }: { dossier: Dossier } = $props();

	const services = $derived(servicesSummary(dossier.services));

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
</script>

<!-- One brass plate for the lab: each system is a section of it, divided by engraved rules. -->
<section class="brass-plate lab-plate" aria-label="Lab systems">
	<div class="brass-plate-face lab-plate-face">
		<section class="plate-section">
			<h2>
				Backup{#if dossier.backup.stale}<span class="plate-status">Stale</span>{/if}
			</h2>
			<dl class="plate-rows">
				<div>
					<dt>Last success</dt>
					<dd>{relative(dossier.backup.lastSuccessAt, dossier.now)}</dd>
				</div>
				<div>
					<dt>Next scheduled</dt>
					<dd>{dateTime(dossier.backup.nextScheduledAt)}</dd>
				</div>
			</dl>
		</section>

		<section class="plate-section">
			<h2>
				Services<span class="plate-status" class:alarm={services.status.tone === "down"}
					>{services.status.label}</span
				>
			</h2>
			<dl class="plate-figures">
				{#each services.stats as stat (stat.label)}
					<div class:alarm={stat.alert}>
						<dt>{stat.label}</dt>
						<dd>{stat.count}</dd>
					</div>
				{/each}
			</dl>
			{#if services.recent}<p class="plate-note alarm">{services.recent}</p>{/if}
		</section>

		<section class="plate-section">
			<h2>
				Host{#if dossier.host.stale}<span class="plate-status">Stale</span>{/if}
			</h2>
			<dl class="plate-rows">
				<div>
					<dt>Disk</dt>
					<dd>
						{dossier.host.diskWorst
							? `${dossier.host.diskWorst.mount} · ${dossier.host.diskWorst.level}`
							: "All caught up."}
					</dd>
				</div>
				<div>
					<dt>Load</dt>
					<dd class="mono">{dossier.host.load}</dd>
				</div>
				<div>
					<dt>Swap</dt>
					<dd class="mono">{dossier.host.swap}</dd>
				</div>
			</dl>
			{#if dossier.host.containerFails.length > 0}
				<p class="plate-note alarm">{dossier.host.containerFails.join(", ")}</p>
			{/if}
		</section>

		<section class="plate-section">
			<h2>Mood</h2>
			<p class="plate-mood">{dossier.mood.mood}</p>
			<blockquote class="plate-quote">{dossier.mood.quote}</blockquote>
		</section>
	</div>
</section>
