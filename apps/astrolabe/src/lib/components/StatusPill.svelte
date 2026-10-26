<script lang="ts">
	type Tone = "ok" | "warn" | "down" | "muted";
	let { label, tone = "muted" }: { label: string; tone?: Tone } = $props();
</script>

<span class="status-pill {tone}"><span class="sdot {tone}"></span>{label}</span>
