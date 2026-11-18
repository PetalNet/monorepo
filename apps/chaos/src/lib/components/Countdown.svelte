<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import { onMount } from "svelte";

	/** A running clock down to `to`. `from` is the server's "now", so the first paint is honest. */
	let { to, from }: { to: string; from: string } = $props();

	// svelte-ignore state_referenced_locally
	let now = $state(Date.parse(from));

	onMount(() => {
		let opened = false;
		const tick = (): void => {
			now = Date.now();

			// The door has unlocked: load the strip again, once.
			if (!opened && now >= Date.parse(to)) {
				opened = true;
				void invalidateAll();
			}
		};

		tick();

		const timer = setInterval(tick, 1000);

		return () => {
			clearInterval(timer);
		};
	});

	const left = $derived(Math.max(0, Math.floor((Date.parse(to) - now) / 1000)));
	const two = (value: number) => String(value).padStart(2, "0");
</script>

<time datetime={to} class="countdown">
	{Math.floor(left / 86_400)}d {two(Math.floor(left / 3600) % 24)}h {two(
		Math.floor(left / 60) % 60,
	)}m
	{two(left % 60)}s
</time>

<style>
	.countdown {
		font-family: var(--font-mono), monospace;
	}
</style>
