<script lang="ts">
	let {
		checked,
		onchange,
		label,
		id,
		disabled = false,
	}: {
		checked: boolean;
		onchange: (value: boolean) => void;
		label: string;
		id?: string;
		disabled?: boolean;
	} = $props();
</script>

<button
	{id}
	type="button"
	role="switch"
	class="switch"
	aria-checked={checked}
	aria-label={label}
	{disabled}
	onclick={() => {
		onchange(!checked);
	}}
>
	<span class="knob"></span>
</button>

<style>
	.switch {
		position: relative;
		flex: none;
		width: 34px;
		height: 20px;
		border: 0;
		border-radius: 999px;
		background: var(--rule-strong);
		cursor: pointer;
		transition: background-color var(--base) var(--ease-standard);
	}

	.switch::after {
		content: "";
		position: absolute;
		inset: -12px -6px;
	}

	.switch[aria-checked="true"] {
		background: var(--accent);
	}

	.switch:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.knob {
		position: absolute;
		top: 2px;
		inset-inline-start: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--sheet);
		box-shadow: 0 1px 2px oklch(0 0 0 / 0.25);
		transition: transform var(--base) var(--ease);
	}

	.switch[aria-checked="true"] .knob {
		transform: translateX(14px);
		background: var(--on-accent);
	}
</style>
