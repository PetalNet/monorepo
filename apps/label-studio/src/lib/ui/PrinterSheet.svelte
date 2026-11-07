<script lang="ts">
	import { TAPE_WIDTHS, type TapeWidthMm } from "$lib/doc";
	import { editor } from "$lib/editor/editor.svelte";
	import { RefreshCw } from "@lucide/svelte";

	import Banner from "./Banner.svelte";
	import Button from "./Button.svelte";
	import { printerStatus } from "./printer.svelte";
	import Row from "./Row.svelte";
	import Select from "./Select.svelte";
	import Sheet from "./Sheet.svelte";
	import { tapeMmActual } from "./tape";
	import { plainError } from "./words";

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let refreshing = $state(false);
	type Summary =
		| { kind: "message"; tone: "info" | "warn" | "danger"; text: string }
		| { kind: "ready"; tape: string; queue: string };

	const summary = $derived.by((): Summary => {
		const connection = printerStatus.connection;

		if (connection.kind === "connecting") {
			return { kind: "message", tone: "info", text: "Checking the printer." };
		}

		if (connection.kind === "unreachable") {
			return { kind: "message", tone: "danger", text: connection.message };
		}

		const { printer, queue } = connection;

		if (printer.state === "offline") {
			return {
				kind: "message",
				tone: "warn",
				text: `${plainError(printer.message)} You can still design for any tape below.`,
			};
		}

		if (printer.state === "error") {
			return { kind: "message", tone: "warn", text: plainError(printer.message) };
		}

		const waiting = queue.pending > 0 ? `, ${String(queue.pending)} waiting` : "";

		return {
			kind: "ready",
			tape: `${String(tapeMmActual(printer.tape.widthMm))} mm, ${String(printer.tape.pins)} printable dots`,
			queue: `${queue.current ? "Printing" : "Idle"}${waiting}`,
		};
	});
	const loaded = $derived(printerStatus.loadedTape);
	const widths = TAPE_WIDTHS.map((width) => ({
		value: width,
		label: `${String(tapeMmActual(width))} mm`,
	}));

	async function refresh(): Promise<void> {
		refreshing = true;
		await printerStatus.refresh();
		refreshing = false;
	}
</script>

<Sheet bind:open title="Printer" width="440px">
	<div class="stack">
		{#if summary.kind === "message"}
			<Banner tone={summary.tone}>{summary.text}</Banner>
		{:else}
			<dl class="facts">
				<dt>State</dt>
				<dd>Ready</dd>
				<dt>Tape loaded</dt>
				<dd class="num">{summary.tape}</dd>
				<dt>Queue</dt>
				<dd class="num">{summary.queue}</dd>
			</dl>
		{/if}

		<Row label="Design for" for="tape-width">
			<Select
				id="tape-width"
				value={editor.doc.tapeMm}
				options={widths}
				onchange={(width: TapeWidthMm) => {
					editor.setTape(width, width !== loaded);
				}}
			/>
		</Row>
		<p class="hint">
			{#if editor.tapePinned && loaded !== null}
				Designing for another cassette. Choose {tapeMmActual(loaded)} mm to follow the loaded tape again.
			{:else}
				The editor follows the loaded tape. Pick another width to design for a different cassette.
			{/if}
		</p>
	</div>

	{#snippet footer()}
		<Button variant="ghost" busy={refreshing} onclick={refresh}
			><RefreshCw size={14} /> Check again</Button
		>
		<Button variant="primary" onclick={() => (open = false)}>Done</Button>
	{/snippet}
</Sheet>

<style>
	.stack {
		display: grid;
		gap: 12px;
	}

	.facts {
		display: grid;
		grid-template-columns: 88px 1fr;
		gap: 6px 8px;
		margin: 0;
	}

	dt {
		color: var(--ink-2);
		font-size: 13px;
	}

	dd {
		margin: 0;
	}

	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}
</style>
