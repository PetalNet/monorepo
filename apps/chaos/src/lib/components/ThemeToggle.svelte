<script lang="ts">
	import Monitor from "@lucide/svelte/icons/monitor";
	import Moon from "@lucide/svelte/icons/moon";
	import Sun from "@lucide/svelte/icons/sun";

	import { MODE_COOKIE, type Mode } from "#lib/mode.ts";

	let { initial }: { initial: Mode } = $props();
	// svelte-ignore state_referenced_locally
	let mode = $state(initial);

	const choices = [
		{ value: "auto", label: "Match device", Icon: Monitor },
		{ value: "light", label: "Light", Icon: Sun },
		{ value: "dark", label: "Dark", Icon: Moon },
	] as const;

	function choose(value: Mode): void {
		mode = value;
		document.documentElement.dataset.mode = value;
		document.cookie = `${MODE_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
	}
</script>

<div class="modes" role="group" aria-label="Theme">
	{#each choices as { value, label, Icon } (value)}
		<button
			type="button"
			aria-pressed={mode === value}
			title={label}
			onclick={() => {
				choose(value);
			}}
		>
			<Icon size={16} strokeWidth={1.75} aria-hidden="true" />
			<span class="sr-only">{label}</span>
		</button>
	{/each}
</div>

<style>
	.modes {
		display: flex;
		gap: 1px;
		background: var(--color-rule);
		border-radius: 2px;
	}
	button {
		display: grid;
		place-items: center;
		inline-size: 44px;
		block-size: 44px;
		background: var(--color-base-200);
		color: var(--color-muted);
		cursor: pointer;
		transition:
			background-color 200ms var(--ease-out-expo),
			color 200ms var(--ease-out-expo);
	}
	button:first-child {
		border-start-start-radius: 2px;
		border-end-start-radius: 2px;
	}
	button:last-child {
		border-start-end-radius: 2px;
		border-end-end-radius: 2px;
	}
	button:hover {
		color: var(--color-base-content);
	}
	button[aria-pressed="true"] {
		background: var(--color-neutral);
		color: var(--color-neutral-content);
	}
	button:focus-visible {
		position: relative;
		z-index: 1;
	}
</style>
