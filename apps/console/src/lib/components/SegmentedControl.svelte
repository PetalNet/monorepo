<script lang="ts" generics="Value extends string">
	interface SegmentOption<Value extends string> {
		value: Value;
		label: string;
		disabled?: boolean;
		title?: string;
	}

	interface Props {
		label: string;
		options: readonly SegmentOption<Value>[];
		value: Value;
		class?: string;
		onchange: (value: Value) => void;
	}

	let { label, options, value, class: className = "", onchange }: Props = $props();
</script>

<div class="segmented-control {className}" role="group" aria-label={label}>
	{#each options as option (option.value)}
		<button
			type="button"
			aria-pressed={value === option.value}
			disabled={option.disabled}
			title={option.title}
			onclick={() => onchange(option.value)}
		>
			{option.label}
		</button>
	{/each}
</div>

<style>
	.segmented-control {
		display: inline-flex;
		align-items: center;
		padding: var(--s-1);
		border-radius: var(--r-pill);
		background: var(--s2);
	}
	button {
		min-height: 32px;
		padding: 0 var(--s-3);
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--text-3);
		font: 500 0.75rem var(--sans);
		cursor: pointer;
		transition: background var(--t), color var(--t);
	}
	button:hover:not(:disabled) {
		background: var(--s3);
		color: var(--text-2);
	}
	button[aria-pressed="true"] {
		background: var(--petal-soft);
		color: var(--petal-text);
	}
	button:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}
</style>
