<script lang="ts">
	import { formatDuration } from "$lib/format";
	import type { LimitReading } from "$lib/limits";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

	let {
		reading,
		now,
		credits = null,
	}: { reading: LimitReading; now: number; credits?: number | null } = $props();

	const STALE_AFTER_MS = 15 * 60 * 1000;

	const percent = (value: number) => `${String(Math.round(value))}%`;
	const creditsLeft = $derived(
		credits === null ? null : new Intl.NumberFormat().format(Math.round(credits)),
	);
	const resetLabel = $derived.by(() => {
		if (reading.resetsAt === null) {
			return null;
		}

		const format = new Intl.DateTimeFormat(
			undefined,
			reading.window.span === "5-hour"
				? { hour: "numeric", minute: "2-digit" }
				: { weekday: "short", hour: "numeric", minute: "2-digit" },
		);

		return `Resets in ${formatDuration(reading.resetsAt - now)} · ${format.format(reading.resetsAt)}`;
	});
	const verdict = $derived.by((): { text: string; detail?: string; alarm: boolean } => {
		switch (reading.state) {
			case "no-reading":
				return { text: "No reading", alarm: false };
			case "reset-since-reading":
				return { text: "Reset since the last reading", alarm: false };
			case "too-early":
				return { text: "Too early to project", alarm: false };
			case "limit-reached":
				return { text: "Limit reached", alarm: true };
			case "on-credits":
				return {
					text: "Using credits",
					detail: creditsLeft === null ? undefined : `${creditsLeft} credits left`,
					alarm: false,
				};
			case "on-pace":
				return { text: `On pace for ${percent(reading.projectedPct ?? 0)} at reset`, alarm: false };
			case "overshoot": {
				const runsOut = reading.runsOutAt;
				const detail =
					runsOut === null ? undefined : `Runs out in ${formatDuration(runsOut - now)}`;

				return {
					text: `On pace for ${percent(reading.projectedPct ?? 0)} at reset`,
					detail,
					alarm: true,
				};
			}
		}
	});
	const age = $derived(
		reading.window.observedAt !== null && now - reading.window.observedAt > STALE_AFTER_MS
			? `Last read ${formatDuration(now - reading.window.observedAt)} ago`
			: null,
	);
	const note = $derived(
		[
			age,
			// While the plaque is drawing on credits, the verdict already carries the balance.
			creditsLeft === null || reading.state === "on-credits" ? null : `${creditsLeft} credits left`,
		]
			.filter((part) => part !== null)
			.join(" · "),
	);
</script>

<article class="plaque {reading.window.id}" class:alarm={verdict.alarm}>
	<div class="plaque-face">
		<h3>
			<span class="swatch" aria-hidden="true"></span>{reading.window.agent} · {reading.window.span}
		</h3>
		{#if reading.usedPct !== null && reading.leftPct !== null}
			<p class="plaque-figure">
				<strong>{percent(reading.usedPct)} used</strong>
				<span>· {percent(reading.leftPct)} left</span>
			</p>
		{/if}
		{#if resetLabel}<p class="plaque-reset">{resetLabel}</p>{/if}
		<div class="plaque-verdict">
			{#if verdict.alarm}<TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />{/if}
			<p>
				<span>{verdict.text}</span>
				{#if verdict.detail}<span class="plaque-detail">{verdict.detail}</span>{/if}
			</p>
		</div>
		{#if note}<p class="plaque-note">{note}</p>{/if}
	</div>
</article>
