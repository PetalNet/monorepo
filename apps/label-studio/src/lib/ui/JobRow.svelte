<script lang="ts">
	import { Check, CircleAlert, RotateCcw, X } from "@lucide/svelte";

	import Button from "./Button.svelte";
	import IconButton from "./IconButton.svelte";
	import { jobs, type TrackedJob } from "./jobs.svelte";
	import { formatMm, plainError } from "./words";

	let { entry, dismissible = true }: { entry: TrackedJob; dismissible?: boolean } = $props();

	let retrying = $state(false);
	let retryError = $state<string | null>(null);
	const job = $derived(entry.job);
	const status = $derived(entry.lost ? "lost" : job.status);
	const words = $derived.by(() => {
		switch (status) {
			case "queued":
				return "Queued";
			case "printing":
				return job.dryRun ? "Rendering dry run" : "Printing";
			case "done":
				return job.dryRun ? "Dry run recorded" : "Printed";
			case "failed":
				return plainError(job.error ?? "Print failed");
			default:
				return entry.lost ?? "";
		}
	});

	async function retry(): Promise<void> {
		retrying = true;
		retryError = null;

		try {
			await jobs.retry(entry);
		} catch (error) {
			retryError = error instanceof Error ? plainError(error.message) : "Retry failed";
		} finally {
			retrying = false;
		}
	}
</script>

<div class="job {status}" role="status" aria-live="polite">
	<span class="mark" aria-hidden="true">
		{#if status === "done"}
			<Check />
		{:else if status === "failed" || status === "lost"}
			<CircleAlert />
		{:else}
			<span class="progress"></span>
		{/if}
	</span>
	<div class="body">
		<strong>{job.title}</strong>
		<span class="meta num">
			{words}
			<span class="sep">·</span>
			{job.pages}
			{job.pages === 1 ? "label" : "labels"}{job.copies > 1 ? ` × ${String(job.copies)}` : ""}
			<span class="sep">·</span>
			{formatMm(job.lengthMm)} mm
		</span>
		{#if retryError}<span class="retry-error">{retryError}</span>{/if}
	</div>
	{#if status === "failed"}
		<Button size="sm" variant="secondary" busy={retrying} onclick={retry}
			><RotateCcw size={14} /> Retry</Button
		>
	{/if}
	{#if dismissible}
		<IconButton
			label="Dismiss"
			onclick={() => {
				jobs.dismiss();
			}}><X /></IconButton
		>
	{/if}
</div>

<style>
	.job {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 8px 10px 12px;
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
		animation: enter var(--slow) var(--ease);
	}

	.mark {
		display: grid;
		place-items: center;
		flex: none;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--sunken);
		color: var(--ink-2);
		transition:
			background-color var(--base),
			color var(--base);
	}

	.mark :global(svg) {
		width: 16px;
		height: 16px;
	}

	.done .mark {
		background: var(--accent-soft);
		color: var(--accent-text);
	}

	.failed .mark,
	.lost .mark {
		background: var(--danger-soft);
		color: var(--danger);
	}

	.progress {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: conic-gradient(var(--accent) 0 30%, transparent 30% 100%);
		mask: radial-gradient(circle, transparent 4.5px, #000 5px);
		animation: spin 800ms linear infinite;
	}

	.body {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}

	strong {
		overflow: hidden;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		color: var(--ink-2);
		font-size: 12px;
	}

	.failed .meta {
		color: var(--danger);
	}

	.sep {
		color: var(--ink-3);
	}

	.retry-error {
		color: var(--danger);
		font-size: 12px;
	}

	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}

	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
</style>
