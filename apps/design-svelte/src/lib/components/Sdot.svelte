<script lang="ts">
	/** A status dot: ok / warn / down, optionally pulsing. */
	let { state = "ok", pulse = false }: { state?: "ok" | "warn" | "down"; pulse?: boolean } =
		$props();
</script>

<span class="sdot {state}{pulse ? ' pulse' : ''}"></span>
