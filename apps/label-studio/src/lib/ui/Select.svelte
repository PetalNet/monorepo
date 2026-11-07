<script lang="ts" generics="T extends string | number">
	import { ChevronDown } from "@lucide/svelte";

	let {
		value,
		options,
		onchange,
		id,
		label,
		disabled = false,
	}: {
		value: T;
		options: readonly { value: T; label: string }[];
		onchange: (value: T) => void;
		id?: string;
		label?: string;
		disabled?: boolean;
	} = $props();
</script>

<span class="select">
	<select
		{id}
		aria-label={label}
		{disabled}
		onchange={(event) => {
			const index = event.currentTarget.selectedIndex;

			onchange(options[index].value);
		}}
	>
		{#each options as option (option.value)}
			<option value={option.value} selected={option.value === value}>{option.label}</option>
		{/each}
	</select>
	<ChevronDown aria-hidden="true" />
</span>

<style>
	.select {
		position: relative;
		display: inline-flex;
		flex: 1;
		min-width: 0;
	}

	select {
		width: 100%;
		height: 32px;
		padding-inline: 8px 28px;
		border: 0;
		border-radius: var(--r);
		background: var(--sunken);
		appearance: none;
		cursor: pointer;
		text-overflow: ellipsis;
	}

	select:hover {
		background: color-mix(in oklch, var(--sunken), var(--ink) 5%);
	}

	select:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}

	.select :global(svg) {
		position: absolute;
		inset-inline-end: 8px;
		top: 50%;
		width: 14px;
		height: 14px;
		color: var(--ink-3);
		pointer-events: none;
		transform: translateY(-50%);
	}

	@media (pointer: coarse) {
		select {
			height: 40px;
		}
	}
</style>
