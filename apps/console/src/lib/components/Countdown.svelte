<script lang="ts">
	/**
	 * Countdown (foundations §3.7): a mono lease timer — amber under 5m, danger
	 * under 1m, "reaped" once the fence increments. Ticks client-side off the
	 * server lease_expires_at; a live clock, not a trusted absolute.
	 */
	interface Props {
		/** RFC 3339 lease expiry; null = no lease held (renders blank). */
		expiresAt: string | null;
		/** True once a fence increment is observed — the lease was reaped. */
		reaped?: boolean;
		now?: number;
	}
	let { expiresAt, reaped = false, now = Date.now() }: Props = $props();

	const remainingMs = $derived(expiresAt ? Date.parse(expiresAt) - now : null);
	const tone = $derived(
		reaped || (remainingMs != null && remainingMs < 60_000)
			? "danger"
			: remainingMs != null && remainingMs < 5 * 60_000
				? "warn"
				: "none",
	);

	function fmt(ms: number): string {
		if (ms <= 0) return "0:00";
		const s = Math.floor(ms / 1000);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	}
</script>

{#if reaped}
	<span class="cd danger">reaped</span>
{:else if remainingMs != null}
	<span class="cd {tone}">{fmt(remainingMs)}</span>
{/if}

<style>
	.cd {
		font:
			500 0.75rem var(--mono);
		font-feature-settings: "tnum" 1;
		color: var(--text-2);
	}
	.warn {
		color: var(--warn-text);
	}
	.danger {
		color: var(--danger-text);
	}
</style>
