<script lang="ts">
	import { TAPE_WIDTHS, dotsToMm, mmToDots, type LabelDoc, type TapeWidthMm } from "$lib/doc";
	import NumberInput from "$lib/ui/NumberInput.svelte";
	import { printerStatus } from "$lib/ui/printer.svelte";
	import Row from "$lib/ui/Row.svelte";
	import Segmented from "$lib/ui/Segmented.svelte";
	import Select from "$lib/ui/Select.svelte";
	import Switch from "$lib/ui/Switch.svelte";
	import { tapeMmActual } from "$lib/ui/tape";

	import { editor } from "./editor.svelte";

	const doc = $derived(editor.doc);
	const loaded = $derived(printerStatus.loadedTape);
	const widths = TAPE_WIDTHS.map((width) => ({
		value: width,
		label: `${String(tapeMmActual(width))} mm`,
	}));
	const round = (value: number): number => Math.round(value * 10) / 10;

	function set(field: string, patch: Partial<LabelDoc>): void {
		editor.apply({ ...editor.doc, ...patch }, `label:${field}`);
	}
</script>

<div class="settings">
	<h3>Label</h3>
	<section>
		<Row label="Tape" for="label-tape">
			<Select
				id="label-tape"
				value={doc.tapeMm}
				options={widths}
				onchange={(width: TapeWidthMm) => {
					editor.setTape(width, width !== loaded);
				}}
			/>
		</Row>
		{#if loaded !== null && loaded !== doc.tapeMm}
			<p class="hint warn">
				{tapeMmActual(loaded)} mm is loaded. Printing needs a matching cassette.
			</p>
		{/if}
		<Row label="Length">
			<Segmented
				label="Length"
				size="sm"
				value={doc.length.mode}
				options={[
					{ value: "auto", label: "Fit content" },
					{ value: "fixed", label: "Fixed" },
				]}
				onchange={(mode: typeof doc.length.mode) => {
					set(
						"length",
						mode === "auto"
							? { length: { mode: "auto" } }
							: { length: { mode: "fixed", mm: round(Math.max(10, dotsToMm(editor.lengthDots))) } },
					);
				}}
			/>
		</Row>
		{#if doc.length.mode === "fixed"}
			<Row label="Fixed at" for="label-length">
				<NumberInput
					id="label-length"
					value={doc.length.mm}
					min={4}
					max={1000}
					step={1}
					unit="mm"
					onchange={(mm: number) => {
						set("length-mm", { length: { mode: "fixed", mm } });
					}}
				/>
			</Row>
		{/if}
		<Row label="Margins" for="label-start">
			<NumberInput
				id="label-start"
				label="Start margin"
				value={doc.margin.startMm}
				min={0}
				step={0.5}
				unit="mm"
				onchange={(startMm: number) => {
					set("margin-start", { margin: { ...doc.margin, startMm } });
				}}
			/>
			<NumberInput
				label="End margin"
				value={doc.margin.endMm}
				min={0}
				step={0.5}
				unit="mm"
				onchange={(endMm: number) => {
					set("margin-end", { margin: { ...doc.margin, endMm } });
				}}
			/>
		</Row>
		<Row label="Orientation">
			<Segmented
				label="Orientation"
				size="sm"
				value={doc.orientation}
				options={[
					{ value: "horizontal", label: "Along tape" },
					{ value: "vertical", label: "Upright" },
				]}
				onchange={(orientation: typeof doc.orientation) => {
					set("orientation", { orientation });
				}}
			/>
		</Row>
		<Row label="Invert" for="label-invert">
			<Switch
				id="label-invert"
				label="Invert label"
				checked={doc.invert}
				onchange={(invert: boolean) => {
					set("invert", { invert });
				}}
			/>
			<span class="hint">Whole label white on black</span>
		</Row>
		<Row label="Border" for="label-border">
			<Switch
				id="label-border"
				label="Border"
				checked={doc.border !== null}
				onchange={(on: boolean) => {
					set("border", { border: on ? { stroke: 3, radius: 6, inset: 2 } : null });
				}}
			/>
		</Row>
		{#if doc.border}
			{@const border = doc.border}
			<Row label="Border" for="border-stroke">
				<NumberInput
					id="border-stroke"
					label="Border width"
					value={round(dotsToMm(border.stroke))}
					min={0.1}
					step={0.1}
					unit="mm"
					onchange={(value: number) => {
						set("border-stroke", { border: { ...border, stroke: Math.max(1, mmToDots(value)) } });
					}}
				/>
				<NumberInput
					label="Border radius"
					value={round(dotsToMm(border.radius))}
					min={0}
					step={0.1}
					unit="mm r"
					onchange={(value: number) => {
						set("border-radius", { border: { ...border, radius: mmToDots(value) } });
					}}
				/>
			</Row>
		{/if}
	</section>
</div>

<style>
	.settings {
		display: grid;
		gap: 4px;
	}

	h3 {
		min-height: 36px;
		display: flex;
		align-items: center;
		font-size: 14px;
		font-weight: 600;
	}

	section {
		display: grid;
		gap: 6px;
		padding-block: 12px;
		box-shadow: 0 -1px 0 var(--rule);
	}

	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}

	.warn {
		color: var(--warn);
	}
</style>
