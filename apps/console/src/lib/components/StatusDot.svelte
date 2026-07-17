<script lang="ts">
	/** 8px status dot (foundations §3.7). Pulse ONLY when streaming, never at idle. */
	interface Props {
		tone?: "good" | "warn" | "danger" | "info" | "idle";
		size?: number;
		pulse?: boolean;
	}
	let { tone = "idle", size = 8, pulse = false }: Props = $props();
</script>

<span class="dot {tone}" class:pulse style="width:{size}px;height:{size}px" aria-hidden="true"></span>

<style>
	.dot {
		border-radius: 50%;
		display: inline-block;
		flex: none;
	}
	.good {
		background: var(--good-dot);
	}
	.warn {
		background: var(--warn-dot);
	}
	.danger {
		background: var(--danger-dot);
	}
	.info {
		background: var(--info-dot);
	}
	.idle {
		background: var(--text-3);
	}
	.pulse {
		animation: pulse 1.6s var(--ease-standard) infinite;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
		}
	}
</style>
