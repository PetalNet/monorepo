<script lang="ts">
	import Icon from "./Icon.svelte";

	interface Props {
		name: string;
		label: string;
		title?: string;
		class?: string;
		disabled?: boolean;
		autofocus?: boolean;
		onclick?: (event: MouseEvent) => void;
	}

	let {
		name,
		label,
		title,
		class: className = "",
		disabled = false,
		autofocus = false,
		onclick,
	}: Props = $props();
</script>

<!-- svelte-ignore a11y_autofocus -->
<button
	type="button"
	class="icon-button {className}"
	aria-label={label}
	{title}
	{disabled}
	{autofocus}
	{onclick}
>
	<Icon {name} size={16} />
</button>

<style>
	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 32px;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 0;
		border-radius: var(--r-sm);
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
		transition: background var(--t), color var(--t);
	}
	.icon-button:hover {
		background: var(--s3);
		color: var(--text);
	}
	.icon-button:active {
		background: var(--petal-soft);
	}
	.icon-button:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}
</style>
