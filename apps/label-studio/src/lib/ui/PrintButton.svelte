<script lang="ts">
	import { Printer, PrinterX } from "@lucide/svelte";
	import type { Snippet } from "svelte";

	import Button from "./Button.svelte";
	import { printerStatus } from "./printer.svelte";

	/**
	 * The top bar's one primary action. While the printer cannot print it drops the accent and says
	 * why; it still opens the print sheet, where Dry run stays available. It turns primary again on
	 * the next status poll that finds the printer ready.
	 */
	let {
		disabled = false,
		onclick,
		children,
	}: { disabled?: boolean; onclick: () => void; children: Snippet } = $props();

	const availability = $derived(printerStatus.availability);
	const live = $derived(availability.kind === "ready" || printerStatus.dryRun);
</script>

<Button
	variant={live ? "primary" : "secondary"}
	{disabled}
	{onclick}
	title={availability.kind === "unavailable" && !printerStatus.dryRun
		? `${availability.reason}. You can still do a dry run.`
		: undefined}
>
	<span class="glyph" class:off={!live} aria-hidden="true">
		{#if live}<Printer size={16} />{:else}<PrinterX size={16} />{/if}
	</span>
	<span>{printerStatus.dryRun ? "Dry run" : "Print"}</span>
	{#if !disabled}<span class="length num" class:muted={!live}>{@render children()}</span>{/if}
</Button>

<style>
	.length {
		padding-inline-start: 8px;
		margin-inline-start: 2px;
		box-shadow: -1px 0 0 color-mix(in oklch, var(--on-accent) 35%, transparent);
		font-weight: 400;
		opacity: 0.9;
	}

	.length.muted {
		box-shadow: -1px 0 0 var(--rule-strong);
		color: var(--ink-2);
	}

	.glyph {
		display: inline-flex;
	}

	.off {
		color: var(--ink-3);
	}
</style>
