<script lang="ts">
	import { onMount } from "svelte";

	import { ringCapacity } from "#lib/dial.ts";
	import { readLimit, type LimitWindow } from "#lib/limits.ts";
	import { quotaStale } from "#lib/quota.ts";
	import type { Dossier } from "#lib/server/dossier.ts";
	import { sunCaption } from "#lib/sky.ts";

	import DayDial from "./DayDial.svelte";
	import WeekDial from "./WeekDial.svelte";

	let { dossier }: { dossier: Dossier } = $props();
	let now = $state<number | null>(null);
	onMount(() => {
		now = Date.now();

		const interval = window.setInterval(() => {
			now = Date.now();
		}, 1_000);

		return () => {
			window.clearInterval(interval);
		};
	});
	const stale = $derived(dossier.quota === null || quotaStale(dossier.quota, now ?? dossier.now));
	const services = $derived(dossier.quota?.services ?? []);
	const windows = $derived.by(() => {
		if (stale || dossier.quota === null) {
			return [];
		}

		return services.flatMap((service) =>
			service.status !== "ok"
				? []
				: service.limits.flatMap((limit): LimitWindow[] => {
						const span = limit.id.endsWith(":5h")
							? "5-hour"
							: limit.id.endsWith(":7d")
								? "7-day"
								: null;

						if (span === null || limit.resetAtMs === null) {
							return [];
						}

						return [
							{
								id: limit.id,
								agent: limit.label,
								span,
								model: null,
								plan: "",
								fit: "listed",
								inactive: false,
								usedPct: limit.usedPct,
								resetsAt: limit.resetAtMs,
								observedAt: dossier.quota?.generatedAt ?? null,
								credits: null,
								hasCredits: null,
								blockedBy: null,
							},
						];
					}),
		);
	});
	const rings = (span: "5-hour" | "7-day") =>
		now === null
			? []
			: windows.filter((item) => item.span === span).map((item) => readLimit(item, now ?? 0));
	const time = (epoch: number) =>
		new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(epoch);
	const sunLine = $derived(now === null ? null : sunCaption(dossier.sun, now, time));
	const reset = (at: number) =>
		new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(at);
</script>

<section class="orloj" aria-label="Usage limits">
	<div class="orloj-dials">
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if now !== null}<DayDial sun={dossier.sun} rings={rings("5-hour")} {now} />{/if}
			</div>
			{#if sunLine}<figcaption>{sunLine}</figcaption>{/if}
		</figure>
		<figure class="orloj-dial">
			<div class="dial-frame">
				{#if now !== null}<WeekDial rings={rings("7-day")} {now} />{/if}
			</div>
			<figcaption>
				{dossier.moon.phaseName}, {Math.round(dossier.moon.illumination * 100)}% lit.
			</figcaption>
		</figure>
	</div>
	{#if dossier.quota === null}<p class="plan-notices">Quota feed unavailable.</p>
	{:else if stale}<p class="plan-notices">
			Quota feed is stale. Last updated {reset(dossier.quota.generatedAt)}.
		</p>{/if}
	{#if windows.filter((item) => item.span === "5-hour").length > ringCapacity("day") || windows.filter((item) => item.span === "7-day").length > ringCapacity("week")}
		<p class="plaque-note">Some limits do not fit on the dials; all are listed below.</p>
	{/if}
	<div class="orloj-plaques">
		{#each services as service, serviceIndex (serviceIndex)}
			{#if service.status !== "ok" || service.limits.length === 0}
				<article class="brass-plate plaque">
					<div class="brass-plate-face">
						<h3>{service.service}</h3>
						<p class="plaque-verdict">
							{service.status === "error"
								? "Reading failed"
								: service.status === "signed-out"
									? "Signed out"
									: "No limit feed"}
						</p>
					</div>
				</article>
			{:else}
				{#each service.limits as limit, limitIndex (limitIndex)}
					<article class="brass-plate plaque">
						<div class="brass-plate-face">
							<h3>{limit.label}</h3>
							{#if stale}<p class="plaque-verdict">Stale reading</p>
							{:else if limit.resetAtMs !== null && now !== null && limit.resetAtMs <= now}<p
									class="plaque-verdict"
								>
									Reset since last reading
								</p>
							{:else}<p class="plaque-figure">
									<strong
										>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
											limit.usedPct,
										)}% used</strong
									>
								</p>
								{#if limit.resetAtMs !== null}<p class="plaque-reset">
										Resets {reset(limit.resetAtMs)}
									</p>{:else if limit.resetLabel}<p class="plaque-reset">
										Resets {limit.resetLabel}
									</p>{/if}
							{/if}
						</div>
					</article>
				{/each}
			{/if}
		{/each}
		{#if !services.some((service) => service.service === "ollama" || service.service === "ollama-cloud")}
			<article class="brass-plate plaque">
				<div class="brass-plate-face">
					<h3>Ollama Cloud</h3>
					<p class="plaque-verdict">No limit feed</p>
				</div>
			</article>
		{/if}
	</div>
</section>
