<script lang="ts">
	import type { PrintRequest } from "$lib/api";
	import type { LabelDoc, Vars } from "$lib/doc";
	import { ChevronRight, Printer } from "@lucide/svelte";

	import Banner from "./Banner.svelte";
	import Button from "./Button.svelte";
	import { errorText } from "./client";
	import JobRow from "./JobRow.svelte";
	import { jobs } from "./jobs.svelte";
	import NumberInput from "./NumberInput.svelte";
	import { printerStatus } from "./printer.svelte";
	import Row from "./Row.svelte";
	import Sheet from "./Sheet.svelte";
	import Switch from "./Switch.svelte";
	import { tapeMmActual } from "./tape";
	import TapeLabel from "./TapeLabel.svelte";
	import { formatMm, plainError } from "./words";

	/**
	 * The one confirmation before tape is spent: what prints (the exact 1-bit render), how many, how
	 * it is cut, and the total length. Then the live job.
	 */
	let {
		open = $bindable(false),
		doc,
		vars = {},
		rows,
		templateId,
		title,
		lengthMm,
	}: {
		open?: boolean;
		doc: LabelDoc;
		vars?: Vars;
		/** Batch: one label per row. */
		rows?: Vars[];
		/** Print by template id instead of an inline document (the server resolves it). */
		templateId?: string;
		title: string;
		/** Length of one copy of the whole sequence. */
		lengthMm: number;
	} = $props();

	let copies = $state(1);
	let cut = $state(true);
	let chain = $state(false);
	let dryRun = $state(false);
	let advanced = $state(false);
	let sending = $state(false);
	let failure = $state<string | null>(null);
	let jobId = $state<string | null>(null);

	const pages = $derived(rows?.length ?? 1);
	const total = $derived(lengthMm * copies);
	const loaded = $derived(printerStatus.loadedTape);
	const printer = $derived(printerStatus.printer);
	const mismatch = $derived(loaded !== null && loaded !== doc.tapeMm);
	const blocked = $derived(!dryRun && printer?.state !== "ready");
	const tracked = $derived(jobId === null ? null : (jobs.find(jobId) ?? null));

	$effect(() => {
		if (open) {
			jobId = null;
			failure = null;
		}
	});

	async function send(): Promise<void> {
		sending = true;
		failure = null;

		const request: PrintRequest = {
			...(templateId === undefined ? { doc: $state.snapshot(doc) } : { template: templateId }),
			vars,
			...(rows ? { rows } : {}),
			copies,
			cut,
			chain,
			dryRun,
			title,
		};

		try {
			const entry = await jobs.print(request);

			jobId = entry.job.id;
		} catch (error) {
			failure = plainError(errorText(error, "Print failed"));
		} finally {
			sending = false;
		}
	}
</script>

<Sheet bind:open title={tracked ? "Print job" : "Print"} width="560px">
	<div class="stage">
		<TapeLabel
			{doc}
			vars={rows?.[0] ? { ...vars, ...rows[0] } : vars}
			mode="print"
			maxWidth={480}
			maxHeight={96}
		/>
		{#if pages > 1}<p class="more num">First of {pages} labels</p>{/if}
	</div>

	{#if tracked}
		<JobRow entry={tracked} dismissible={false} />
	{:else}
		<div class="rows">
			<Row label="Copies" for="print-copies">
				<NumberInput
					id="print-copies"
					value={copies}
					min={1}
					max={99}
					onchange={(value: number) => {
						copies = Math.round(value);
					}}
				/>
			</Row>
			<Row label="Cut" for="print-cut">
				<Switch
					id="print-cut"
					checked={cut}
					label="Cut after every label"
					onchange={(value: boolean) => {
						cut = value;
					}}
				/>
				<span class="hint">{cut ? "After every label" : "One strip, cut at the end"}</span>
			</Row>
			<Row label="Chain" for="print-chain">
				<Switch
					id="print-chain"
					checked={chain}
					label="Chain with the next job"
					onchange={(value: boolean) => {
						chain = value;
					}}
				/>
				<span class="hint">{chain ? "No final feed, saves tape" : "Feed and cut at the end"}</span>
			</Row>
		</div>

		<button
			class="advanced"
			type="button"
			aria-expanded={advanced}
			onclick={() => (advanced = !advanced)}
		>
			<ChevronRight size={14} /> Advanced
		</button>
		{#if advanced}
			<div class="rows">
				<Row label="Dry run" for="print-dry">
					<Switch
						id="print-dry"
						checked={dryRun}
						label="Dry run"
						onchange={(value: boolean) => {
							dryRun = value;
						}}
					/>
					<span class="hint">Render and record, do not print</span>
				</Row>
			</div>
		{/if}

		<div class="total">
			<span>Tape used</span>
			<strong class="num">{formatMm(total)} mm</strong>
			<span class="num breakdown">
				{pages}
				{pages === 1 ? "label" : "labels"}{copies > 1 ? ` × ${String(copies)} copies` : ""}
			</span>
		</div>

		{#if mismatch && loaded !== null}
			<Banner tone="warn">
				Designed for {tapeMmActual(doc.tapeMm)} mm tape, but {tapeMmActual(loaded)} mm is loaded. The
				printer will refuse it.
			</Banner>
		{:else if blocked}
			<Banner tone="warn">
				{printer === null
					? "Cannot reach the printer."
					: printer.state === "ready"
						? ""
						: plainError(printer.message)}
				Turn on Dry run under Advanced to record it without printing.
			</Banner>
		{/if}
		{#if failure}<Banner tone="danger">{failure}</Banner>{/if}
	{/if}

	{#snippet footer()}
		{#if tracked}
			<Button variant="primary" onclick={() => (open = false)}>Done</Button>
		{:else}
			<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			<Button variant="primary" busy={sending} disabled={blocked || mismatch} onclick={send}>
				<Printer size={16} />
				{dryRun ? "Dry run" : `Print ${formatMm(total)} mm`}
			</Button>
		{/if}
	{/snippet}
</Sheet>

<style>
	.stage {
		display: grid;
		place-items: center;
		gap: 8px;
		margin-inline: -20px;
		margin-bottom: 16px;
		padding: 28px 20px 16px;
		background: var(--ground);
		--dimension-bg: var(--ground);
	}

	.more {
		color: var(--ink-3);
		font-size: 12px;
	}

	.rows {
		display: grid;
		gap: 4px;
	}

	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}

	.advanced {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-block: 8px 4px;
		padding: 4px 0;
		border: 0;
		background: none;
		color: var(--ink-2);
		font-size: 13px;
		cursor: pointer;
	}

	.advanced :global(svg) {
		transition: transform var(--base) var(--ease);
	}

	.advanced[aria-expanded="true"] :global(svg) {
		transform: rotate(90deg);
	}

	.total {
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: baseline;
		margin-block: 16px 12px;
		padding-top: 12px;
		box-shadow: 0 -1px 0 var(--rule);
	}

	.total span:first-child {
		color: var(--ink-2);
	}

	.total strong {
		font-size: 22px;
		font-weight: 500;
	}

	.breakdown {
		grid-column: 1 / -1;
		justify-self: end;
		color: var(--ink-3);
		font-size: 12px;
	}
</style>
