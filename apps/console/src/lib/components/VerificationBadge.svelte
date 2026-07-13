<script lang="ts">
	import Icon from "./Icon.svelte";
	let { status = "unverified", word = true }: { status?: "unverified" | "verified" | "rejected"; word?: boolean } = $props();
	const icon = $derived(status === "verified" ? "circle-check" : status === "rejected" ? "circle-x" : "circle-dashed");
</script>
<span class="verification {status}" title={status} aria-label={`Verification: ${status}`}><Icon name={icon} size={12}/>{#if word}<span>{status}</span>{/if}</span>
<style>
	.verification{display:inline-flex;align-items:center;gap:var(--s-1);font:500 .6875rem var(--mono);color:var(--text-3)}.verified{color:var(--good-text)}.rejected{color:var(--danger-text)}
</style>
