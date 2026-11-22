<script lang="ts">
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

	import { formatDuration } from "#lib/format.ts";
	import type { LimitReading } from "#lib/limits.ts";

	let {
		reading,
		now,
		onDial,
	}: {
		reading: LimitReading;
		now: number;
		/** Whether a dial has a ring for this limit. The dials have fewer rings than there are limits. */
		onDial: boolean;
	} = $props();

	/** A figure the feed gives in tenths, such as 15.5%, keeps them. */
	const percent = (value: number, digits = 0) => `${String(Number(value.toFixed(digits)))}%`;
	// A reset is told by as much of the date as its span leaves open: the hour within a day, the
	// weekday within a week, the date past that.
	const RESET_FORMATS = {
		"5-hour": { hour: "numeric", minute: "2-digit" },
		"7-day": { weekday: "short", hour: "numeric", minute: "2-digit" },
		none: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
	} satisfies Record<string, Intl.DateTimeFormatOptions>;
	const resetLabel = $derived.by(() => {
		if (reading.resetsAt === null) {
			return null;
		}

		const format = new Intl.DateTimeFormat(undefined, RESET_FORMATS[reading.window.span ?? "none"]);

		return `Resets in ${formatDuration(reading.resetsAt - now)} · ${format.format(reading.resetsAt)}`;
	});
	const verdict = $derived.by((): { text: string; detail?: string; alarm: boolean } | null => {
		switch (reading.state) {
			case "unpaced":
				return null;
			case "no-reading":
				return { text: "No reading", alarm: false };
			case "reset-since-reading":
				return { text: "Reset since the last reading", alarm: false };
			case "too-early":
				return { text: "Too early to project", alarm: false };
			case "limit-reached":
				return { text: "Limit reached", alarm: true };
			case "on-credits":
				return { text: "Using credits", alarm: false };
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
</script>

<section class="limit-row" data-limit={reading.window.id} class:alarm={verdict?.alarm}>
	<h3>
		<!-- The pip is the colour of the limit's ring, so a limit without a ring has none. -->
		{#if onDial}<span class="swatch" aria-hidden="true"></span>{/if}{reading.window.name}
	</h3>
	{#if reading.usedPct !== null}
		<p class="limit-figure"><strong>{percent(reading.usedPct, 1)}</strong> used</p>
	{/if}
	{#if resetLabel !== null || reading.leftPct !== null}
		<p class="limit-reset">
			{#if resetLabel}<span>{resetLabel}</span>{/if}
			{#if reading.leftPct !== null}
				<span class="limit-left">{percent(reading.leftPct, 1)} left</span>
			{/if}
		</p>
	{/if}
	{#if verdict}
		<div class="limit-verdict">
			{#if verdict.alarm}<TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />{/if}
			<p>
				<span>{verdict.text}</span>
				{#if verdict.detail}<span class="limit-detail">{verdict.detail}</span>{/if}
			</p>
		</div>
	{/if}
	{#if reading.window.inactive}<p class="limit-note">Marked inactive</p>{/if}
</section>
