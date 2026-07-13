<script lang="ts">
	import Icon from "./Icon.svelte";

	interface Props {
		handle: string | null;
		label?: string;
	}

	let { handle, label = "composed by" }: Props = $props();
	const name = $derived(handle ?? "unknown principal");
</script>

<span class="agent-presence" title="{label} {name}">
	<Icon name={name.toLowerCase() === "janet" ? "sparkles" : "users-round"} size={12} />
	<span>{label} {name}</span>
</span>

<style>
	.agent-presence {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
		min-height: 24px;
		color: var(--jade-text);
		font: 500 0.6875rem var(--mono);
	}
</style>
