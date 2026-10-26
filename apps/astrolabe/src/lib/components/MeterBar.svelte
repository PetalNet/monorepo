<script lang="ts">
	let { label, value, reset }: { label: string; value: number | null; reset: string | null } = $props();
	const display = $derived(value === null ? "No reading" : `${Math.round(value)}%`);
	const width = $derived(value === null ? 0 : Math.max(0, Math.min(100, value)));
</script>

<div class="meter">
	<div class="meter-label"><span>{label}</span><span class="mono">{display}</span></div>
	<div class="meter-track" aria-label={`${label}: ${display}`} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={value ?? undefined}>
		<span class="meter-fill" style:width={`${width}%`}></span>
	</div>
	{#if reset}<p class="meter-reset">Resets {reset}</p>{/if}
</div>
