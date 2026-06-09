<script lang="ts">
	import Sdot from "./Sdot.svelte";

	/** A status pill: a dot plus a label. */
	let {
		state = "ok",
		pulse = false,
		label,
	}: { state?: "ok" | "warn" | "down"; pulse?: boolean; label: string } = $props();
</script>

<span class="status-pill"><Sdot {state} {pulse} /> {label}</span>
