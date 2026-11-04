<script lang="ts">
	import { dotsToMm, mmToDots, placeholders, type LabelElement, type Rotation } from "$lib/doc";
	import Banner from "$lib/ui/Banner.svelte";
	import IconButton from "$lib/ui/IconButton.svelte";
	import NumberInput from "$lib/ui/NumberInput.svelte";
	import Row from "$lib/ui/Row.svelte";
	import Segmented from "$lib/ui/Segmented.svelte";
	import Select from "$lib/ui/Select.svelte";
	import Switch from "$lib/ui/Switch.svelte";
	import {
		AlignCenterHorizontal,
		AlignCenterVertical,
		AlignEndHorizontal,
		AlignEndVertical,
		AlignStartHorizontal,
		AlignStartVertical,
		ArrowDownToLine,
		ArrowUpToLine,
		Bold,
		Copy,
		Italic,
		Lock,
		LockOpen,
		TextAlignCenter,
		TextAlignEnd,
		TextAlignStart,
		Trash2,
	} from "@lucide/svelte";

	import { editor } from "./editor.svelte";
	import { FONTS } from "./fonts";
	import IconPicker from "./IconPicker.svelte";
	import { elementLabel, mapElements, SYMBOLOGY_NAMES, type AlignEdge } from "./model";
	import Slider from "./Slider.svelte";

	const selected = $derived(editor.selected);
	const element = $derived(selected.length === 1 ? selected[0] : null);
	let textArea = $state<HTMLTextAreaElement>();
	let changingIcon = $state(false);

	$effect(() => {
		if (editor.focusText === element?.id && textArea) {
			textArea.focus();
			textArea.select();
			editor.focusText = null;
		}
	});

	/** Edits to one field of one element merge into a single undo step while typing or dragging. */
	function patch(field: string, value: Partial<LabelElement>): void {
		if (!element) {
			return;
		}

		const id = element.id;

		editor.apply(
			mapElements(editor.doc, [id], (current) => ({ ...current, ...value }) as LabelElement),
			`edit:${id}:${field}`,
		);
	}

	const mm = (dots: number): number => Math.round(dotsToMm(dots) * 10) / 10;

	const aligns: { edge: AlignEdge; label: string; icon: typeof AlignStartVertical }[] = [
		{ edge: "left", label: "Align left", icon: AlignStartVertical },
		{ edge: "center", label: "Align centre", icon: AlignCenterVertical },
		{ edge: "right", label: "Align right", icon: AlignEndVertical },
		{ edge: "top", label: "Align top", icon: AlignStartHorizontal },
		{ edge: "middle", label: "Align middle", icon: AlignCenterHorizontal },
		{ edge: "bottom", label: "Align bottom", icon: AlignEndHorizontal },
	];
	const rotations = [
		{ value: "0", label: "0°" },
		{ value: "90", label: "90°" },
		{ value: "180", label: "180°" },
		{ value: "270", label: "270°" },
	] as const;
	const allLocked = $derived(selected.length > 0 && selected.every((item) => item.locked));
	const variables = $derived(placeholders(editor.doc));
</script>

<div class="inspector">
	<header class="head">
		<h3>
			{selected.length > 1
				? `${String(selected.length)} elements`
				: element
					? elementLabel(element)
					: ""}
		</h3>
		<div class="actions">
			<IconButton
				label="Bring forward"
				onclick={() => {
					editor.layer("forward");
				}}><ArrowUpToLine /></IconButton
			>
			<IconButton
				label="Send backward"
				onclick={() => {
					editor.layer("backward");
				}}><ArrowDownToLine /></IconButton
			>
			<IconButton
				label="Duplicate"
				onclick={() => {
					editor.duplicateSelection();
				}}><Copy /></IconButton
			>
			<IconButton
				label={allLocked ? "Unlock" : "Lock"}
				pressed={allLocked}
				onclick={() => {
					editor.apply(
						mapElements(editor.doc, editor.selection, (item) => ({ ...item, locked: !allLocked })),
					);
				}}
			>
				{#if allLocked}<Lock />{:else}<LockOpen />{/if}
			</IconButton>
			<IconButton
				label="Delete"
				disabled={allLocked}
				onclick={() => {
					editor.deleteSelection();
				}}><Trash2 /></IconButton
			>
		</div>
	</header>

	<section>
		<h4>{selected.length > 1 ? "Align to each other" : "Align to band"}</h4>
		<div class="aligns">
			{#each aligns as item (item.edge)}
				<IconButton
					label={item.label}
					disabled={allLocked}
					onclick={() => {
						editor.align(item.edge);
					}}
				>
					<item.icon />
				</IconButton>
			{/each}
		</div>
	</section>

	{#if element}
		{#if element.kind === "text"}
			<section>
				<label class="sr-only" for="text-value">Text</label>
				<textarea
					id="text-value"
					bind:this={textArea}
					rows={Math.min(4, element.text.split("\n").length + 1)}
					value={element.text}
					placeholder="Type the label text"
					oninput={(event) => {
						patch("text", { text: event.currentTarget.value });
					}}></textarea>
				<p class="hint">
					Use {"{{name}}"} for a field you fill in per label{variables.length > 0
						? `: ${variables.join(", ")}`
						: ""}.
				</p>
				<Row label="Font" for="text-font">
					<Select
						id="text-font"
						value={element.font}
						options={FONTS.map((font) => ({ value: font.id, label: font.name }))}
						onchange={(font: typeof element.font) => {
							patch("font", { font });
						}}
					/>
				</Row>
				<Row label="Style">
					<IconButton
						label="Bold"
						pressed={element.bold}
						onclick={() => {
							patch("bold", { bold: !element.bold });
						}}
					>
						<Bold />
					</IconButton>
					<IconButton
						label="Italic"
						pressed={element.italic}
						onclick={() => {
							patch("italic", { italic: !element.italic });
						}}><Italic /></IconButton
					>
					<span class="spacer"></span>
					<IconButton
						label="Align text left"
						pressed={element.align === "left"}
						onclick={() => {
							patch("align", { align: "left" });
						}}
					>
						<TextAlignStart />
					</IconButton>
					<IconButton
						label="Centre text"
						pressed={element.align === "center"}
						onclick={() => {
							patch("align", { align: "center" });
						}}><TextAlignCenter /></IconButton
					>
					<IconButton
						label="Align text right"
						pressed={element.align === "right"}
						onclick={() => {
							patch("align", { align: "right" });
						}}><TextAlignEnd /></IconButton
					>
				</Row>
				<Row label="Fit">
					<Segmented
						label="Text fit"
						size="sm"
						value={element.fit}
						options={[
							{ value: "fill", label: "Fill" },
							{ value: "shrink", label: "Shrink" },
							{ value: "fixed", label: "Fixed" },
						]}
						onchange={(fit: typeof element.fit) => {
							patch("fit", { fit });
						}}
					/>
				</Row>
				<Row label={element.fit === "fill" ? "Max size" : "Size"} for="text-size">
					<NumberInput
						id="text-size"
						value={mm(element.size)}
						step={0.5}
						min={0.5}
						unit="mm"
						onchange={(value: number) => {
							patch("size", { size: Math.max(2, mmToDots(value)) });
						}}
					/>
				</Row>
				<Row label="Vertical">
					<Segmented
						label="Vertical alignment"
						size="sm"
						value={element.valign}
						options={[
							{ value: "top", label: "Top" },
							{ value: "middle", label: "Middle" },
							{ value: "bottom", label: "Bottom" },
						]}
						onchange={(valign: typeof element.valign) => {
							patch("valign", { valign });
						}}
					/>
				</Row>
				<Row label="Width">
					<Segmented
						label="Width"
						size="sm"
						value={element.widthMode}
						options={[
							{ value: "auto", label: "Hug text" },
							{ value: "fixed", label: "Fixed" },
						]}
						onchange={(widthMode: typeof element.widthMode) => {
							patch("widthMode", { widthMode });
						}}
					/>
				</Row>
				<Slider
					label="Line height"
					value={element.lineHeight}
					min={0.7}
					max={2}
					step={0.05}
					format={(value: number) => `${value.toFixed(2)}×`}
					onchange={(lineHeight: number) => {
						patch("lineHeight", { lineHeight });
					}}
				/>
				<Slider
					label="Tracking"
					value={element.tracking}
					min={-4}
					max={12}
					step={0.5}
					format={(value: number) => `${value.toFixed(1)} dots`}
					onchange={(tracking: number) => {
						patch("tracking", { tracking });
					}}
				/>
			</section>
		{:else if element.kind === "icon"}
			<section>
				{#if changingIcon}
					<IconPicker
						current={element.icon}
						onpick={(icon: string) => {
							patch("icon", { icon });
							changingIcon = false;
						}}
					/>
				{:else}
					<Row label="Icon">
						<button class="link" type="button" onclick={() => (changingIcon = true)}
							>{element.icon}</button
						>
					</Row>
				{/if}
				<Slider
					label="Stroke"
					value={element.stroke}
					min={0.5}
					max={4}
					step={0.25}
					format={(value: number) => value.toFixed(2)}
					onchange={(stroke: number) => {
						patch("stroke", { stroke });
					}}
				/>
			</section>
		{:else if element.kind === "shape"}
			<section>
				<Row label="Shape" for="shape-kind">
					<Select
						id="shape-kind"
						value={element.shape}
						options={[
							{ value: "rect", label: "Rectangle" },
							{ value: "ellipse", label: "Ellipse" },
							{ value: "line-h", label: "Line across" },
							{ value: "line-v", label: "Line down" },
						]}
						onchange={(shape: typeof element.shape) => {
							patch("shape", { shape });
						}}
					/>
				</Row>
				<Slider
					label={element.shape.startsWith("line") ? "Thickness" : "Outline"}
					value={element.stroke}
					min={element.shape.startsWith("line") ? 1 : 0}
					max={20}
					step={1}
					format={(value: number) => `${String(value)} dots`}
					onchange={(stroke: number) => {
						patch("stroke", { stroke });
					}}
				/>
				{#if element.shape === "rect"}
					<Slider
						label="Radius"
						value={element.radius}
						min={0}
						max={Math.round(Math.min(element.w, element.h) / 2)}
						step={1}
						format={(value: number) => `${String(value)} dots`}
						onchange={(radius: number) => {
							patch("radius", { radius });
						}}
					/>
				{/if}
				{#if !element.shape.startsWith("line")}
					<Row label="Fill" for="shape-fill">
						<Switch
							id="shape-fill"
							label="Fill"
							checked={element.fill}
							onchange={(fill: boolean) => {
								patch("fill", { fill });
							}}
						/>
					</Row>
				{/if}
				<Row label="Dashed" for="shape-dashed">
					<Switch
						id="shape-dashed"
						label="Dashed"
						checked={element.dashed}
						onchange={(dashed: boolean) => {
							patch("dashed", { dashed });
						}}
					/>
				</Row>
			</section>
		{:else if element.kind === "image"}
			<section>
				<Row label="Mode">
					<Segmented
						label="Image mode"
						size="sm"
						value={element.mode}
						options={[
							{ value: "dither", label: "Dither" },
							{ value: "threshold", label: "Threshold" },
						]}
						onchange={(mode: typeof element.mode) => {
							patch("mode", { mode });
						}}
					/>
				</Row>
				<Slider
					label={element.mode === "threshold" ? "Threshold" : "Brightness"}
					value={element.threshold}
					min={0}
					max={255}
					step={1}
					format={(value: number) => String(value)}
					onchange={(threshold: number) => {
						patch("threshold", { threshold });
					}}
				/>
				<Row label="Fit" for="image-fit">
					<Select
						id="image-fit"
						value={element.fit}
						options={[
							{ value: "contain", label: "Fit inside" },
							{ value: "cover", label: "Fill and crop" },
							{ value: "stretch", label: "Stretch" },
						]}
						onchange={(fit: typeof element.fit) => {
							patch("fit", { fit });
						}}
					/>
				</Row>
				<p class="hint">Switch to print view to see the exact dots.</p>
			</section>
		{:else if element.kind === "code"}
			<section>
				<Row label="Type" for="code-type">
					<Select
						id="code-type"
						value={element.symbology}
						options={Object.entries(SYMBOLOGY_NAMES).map(([value, label]) => ({
							value: value as keyof typeof SYMBOLOGY_NAMES,
							label,
						}))}
						onchange={(symbology: typeof element.symbology) => {
							patch("symbology", { symbology });
						}}
					/>
				</Row>
				<Row label="Data" for="code-data">
					<input
						id="code-data"
						class="text"
						value={element.data}
						spellcheck="false"
						autocomplete="off"
						oninput={(event) => {
							patch("data", { data: event.currentTarget.value });
						}}
					/>
				</Row>
				{#if element.symbology === "qr"}
					<Row label="Recovery">
						<Segmented
							label="Error correction"
							size="sm"
							value={element.ecc}
							options={[
								{ value: "L", label: "L" },
								{ value: "M", label: "M" },
								{ value: "Q", label: "Q" },
								{ value: "H", label: "H" },
							]}
							onchange={(ecc: typeof element.ecc) => {
								patch("ecc", { ecc });
							}}
						/>
					</Row>
				{/if}
				{#if element.symbology === "code128" || element.symbology === "ean13"}
					<Row label="Show text" for="code-text">
						<Switch
							id="code-text"
							label="Print human-readable text"
							checked={element.showText}
							onchange={(showText: boolean) => {
								patch("showText", { showText });
							}}
						/>
					</Row>
				{/if}
			</section>
		{/if}

		<section>
			<h4>Position</h4>
			<div class="grid">
				<Row label="X" for="pos-x">
					<NumberInput
						id="pos-x"
						value={mm(element.x)}
						step={0.1}
						unit="mm"
						onchange={(value: number) => {
							patch("x", { x: mmToDots(value) });
						}}
					/>
				</Row>
				<Row label="Y" for="pos-y">
					<NumberInput
						id="pos-y"
						value={mm(element.y)}
						step={0.1}
						unit="mm"
						onchange={(value: number) => {
							patch("y", { y: mmToDots(value) });
						}}
					/>
				</Row>
				<Row label="W" for="pos-w">
					<NumberInput
						id="pos-w"
						value={mm(editor.boxes[element.id]?.w ?? element.w)}
						step={0.1}
						min={0.1}
						unit="mm"
						onchange={(value: number) => {
							patch("w", {
								w: Math.max(1, mmToDots(value)),
								...(element.kind === "text" ? { widthMode: "fixed" } : {}),
							});
						}}
					/>
				</Row>
				<Row label="H" for="pos-h">
					<NumberInput
						id="pos-h"
						value={mm(element.h)}
						step={0.1}
						min={0.1}
						unit="mm"
						onchange={(value: number) => {
							patch("h", { h: Math.max(1, mmToDots(value)) });
						}}
					/>
				</Row>
			</div>
			<Row label="Rotate">
				<Segmented
					label="Rotation"
					size="sm"
					value={String(element.rotate) as "0" | "90" | "180" | "270"}
					options={rotations}
					onchange={(value: "0" | "90" | "180" | "270") => {
						const rotate = Number(value) as Rotation;
						const quarter = (rotate - element.rotate) % 180 !== 0;

						patch("rotate", quarter ? { rotate, w: element.h, h: element.w } : { rotate });
					}}
				/>
			</Row>
			<Row label="Invert" for="el-invert">
				<Switch
					id="el-invert"
					label="White on black"
					checked={element.invert}
					onchange={(invert: boolean) => {
						patch("invert", { invert });
					}}
				/>
				<span class="hint">White on black</span>
			</Row>
		</section>

		{#each editor.warnings as warning (warning)}
			<Banner tone="warn">{warning}</Banner>
		{/each}
	{/if}
</div>

<style>
	.inspector {
		display: grid;
		gap: 4px;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 36px;
	}

	h3 {
		overflow: hidden;
		font-size: 14px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		gap: 2px;
	}

	section {
		display: grid;
		gap: 6px;
		padding-block: 12px;
		box-shadow: 0 -1px 0 var(--rule);
	}

	h4 {
		color: var(--ink-3);
		font-size: 12px;
		font-weight: 500;
	}

	.aligns {
		display: flex;
		justify-content: space-between;
	}

	textarea,
	.text {
		width: 100%;
		min-width: 0;
		padding: 8px;
		border: 0;
		border-radius: var(--r);
		background: var(--sunken);
		resize: vertical;
		line-height: 1.35;
	}

	.text {
		height: 32px;
	}

	textarea:focus-visible,
	.text:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}

	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}

	.spacer {
		flex: 1;
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px 12px;
	}

	.grid :global(.row) {
		grid-template-columns: 16px minmax(0, 1fr);
	}

	.link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent-text);
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}
</style>
