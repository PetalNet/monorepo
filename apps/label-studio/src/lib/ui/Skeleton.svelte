<script lang="ts">
	let {
		width = "100%",
		height = "16px",
		radius = "var(--r)",
	}: { width?: string; height?: string; radius?: string } = $props();
</script>

<span class="skeleton" style:width style:height style:border-radius={radius} aria-hidden="true"
></span>

<style>
	.skeleton {
		display: block;
		background: linear-gradient(90deg, var(--sunken) 0%, var(--rule) 50%, var(--sunken) 100%);
		background-size: 200% 100%;
		animation: shimmer 1.4s var(--ease-standard) infinite;
	}

	@keyframes shimmer {
		from {
			background-position: 100% 0;
		}

		to {
			background-position: -100% 0;
		}
	}
</style>
