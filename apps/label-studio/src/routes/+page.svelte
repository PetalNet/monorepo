<script lang="ts">
	import { goto } from "$app/navigation";
	import { resolve } from "$app/paths";
	import { dotsToMm, placeholders } from "$lib/doc";
	import Canvas from "$lib/editor/Canvas.svelte";
	import { editor, type PanelTab, type View } from "$lib/editor/editor.svelte";
	import EditPane from "$lib/editor/EditPane.svelte";
	import Fields from "$lib/editor/Fields.svelte";
	import { insertImage } from "$lib/editor/insert-image";
	import { createElement } from "$lib/editor/model";
	import Panel from "$lib/editor/Panel.svelte";
	import SaveTemplateSheet from "$lib/editor/SaveTemplateSheet.svelte";
	import { resolveShortcut } from "$lib/editor/shortcuts";
	import ShortcutSheet from "$lib/editor/ShortcutSheet.svelte";
	import Button from "$lib/ui/Button.svelte";
	import { chrome } from "$lib/ui/chrome.svelte";
	import IconButton from "$lib/ui/IconButton.svelte";
	import PrintSheet from "$lib/ui/PrintSheet.svelte";
	import Segmented from "$lib/ui/Segmented.svelte";
	import { formatMm } from "$lib/ui/words";
	import {
		Eye,
		FilePlusCorner,
		Keyboard,
		LayoutGrid,
		Maximize,
		Minus,
		PenLine,
		Plus,
		Printer,
		Redo2,
		Save,
		Type,
		Undo2,
	} from "@lucide/svelte";
	import { onDestroy } from "svelte";
	import { MediaQuery } from "svelte/reactivity";

	/** CSS pixels per printer dot at real size: 96 CSS px per inch over 180 dots per inch. */
	const ACTUAL_SIZE = 96 / 180;
	const wide = new MediaQuery("min-width: 1100px");
	let tab = $state<PanelTab>("add");
	const setTab = (next: PanelTab): void => {
		tab = next;
	};
	let printing = $state(false);
	let saving = $state(false);
	let help = $state(false);

	const lengthMm = $derived(dotsToMm(editor.lengthDots));
	const empty = $derived(editor.doc.elements.length === 0);
	const showFields = $derived(editor.template !== null || placeholders(editor.doc).length > 0);
	const title = $derived(
		editor.template?.name ??
			editor.doc.elements.find((element) => element.kind === "text")?.text.split("\n")[0] ??
			"Label",
	);

	// Selecting something on a narrow screen brings its inspector forward.
	$effect(() => {
		if (!wide.current && editor.selection.length > 0 && tab === "add") {
			tab = "edit";
		}
	});

	$effect(() => {
		if (wide.current && tab === "edit") {
			tab = "add";
		}
	});

	chrome.actions = printAction;
	onDestroy(() => {
		chrome.actions = null;
	});

	function editText(id: string): void {
		editor.select([id]);
		editor.focusText = id;

		if (!wide.current) {
			tab = "edit";
		}
	}

	function typing(target: EventTarget | null): boolean {
		return (
			target instanceof HTMLElement &&
			(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
		);
	}

	function keydown(event: KeyboardEvent): void {
		if (typing(event.target) || document.querySelector("dialog[open]")) {
			return;
		}

		const command = resolveShortcut(event);

		if (!command) {
			return;
		}

		event.preventDefault();

		switch (command.kind) {
			case "nudge":
				editor.nudge(command.dx, command.dy);

				break;
			case "undo":
				editor.undo();

				break;
			case "redo":
				editor.redo();

				break;
			case "duplicate":
				editor.duplicateSelection();

				break;
			case "delete":
				editor.deleteSelection();

				break;
			case "layer":
				editor.layer(command.move);

				break;
			case "zoom":
				if (command.to === "fit") {
					editor.setZoom(null);
				} else {
					editor.zoomBy(command.to === "in" ? 1.25 : 0.8);
				}

				break;
			case "select-all":
				editor.select(editor.doc.elements.map((element) => element.id));

				break;
			case "escape":
				editor.select([]);

				break;
			case "help":
				help = true;

				break;
			case "view":
				editor.view = editor.view === "design" ? "print" : "design";

				break;
		}
	}

	function paste(event: ClipboardEvent): void {
		if (typing(event.target) || !event.clipboardData) {
			return;
		}

		const file = [...event.clipboardData.files].find((candidate) =>
			candidate.type.startsWith("image/"),
		);

		if (file) {
			event.preventDefault();
			void insertImage(file);

			return;
		}

		const text = event.clipboardData.getData("text/plain").trim();

		if (text !== "") {
			event.preventDefault();
			const element = createElement(editor.doc, "text");

			editor.insert({ ...element, ...(element.kind === "text" ? { text } : {}) });
		}
	}
</script>

<svelte:window onkeydown={keydown} onpaste={paste} />

{#snippet printAction()}
	<Button variant="primary" disabled={empty} onclick={() => (printing = true)}>
		<Printer size={16} />
		<span>Print</span>
		{#if !empty}<span class="length num">{formatMm(lengthMm)} mm</span>{/if}
	</Button>
{/snippet}

<div class="editor" class:wide={wide.current}>
	{#if wide.current}
		<aside class="side start">
			<Panel wide {tab} onchange={setTab} />
		</aside>
	{/if}

	<section class="work">
		<div class="toolbar">
			<div class="group">
				<IconButton
					label="Undo"
					disabled={!editor.canUndo}
					onclick={() => {
						editor.undo();
					}}><Undo2 /></IconButton
				>
				<IconButton
					label="Redo"
					disabled={!editor.canRedo}
					onclick={() => {
						editor.redo();
					}}><Redo2 /></IconButton
				>
			</div>
			<Segmented
				label="View"
				size="sm"
				options={[
					{ value: "design", label: "Design", icon: designIcon },
					{ value: "print", label: "Print view", icon: printIcon },
				]}
				value={editor.view}
				onchange={(next: View) => {
					editor.view = next;
				}}
			/>
			<div class="group zoom">
				<IconButton
					label="Zoom out"
					onclick={() => {
						editor.zoomBy(0.8);
					}}><Minus /></IconButton
				>
				<button
					class="zoom-value num"
					type="button"
					title="Zoom to fit. 100% is the label's real size."
					onclick={() => {
						editor.setZoom(null);
					}}
				>
					{Math.round((editor.effectiveZoom / ACTUAL_SIZE) * 100)}%
				</button>
				<IconButton
					label="Zoom in"
					onclick={() => {
						editor.zoomBy(1.25);
					}}><Plus /></IconButton
				>
				<IconButton
					label="Zoom to fit"
					pressed={editor.zoom === null}
					onclick={() => {
						editor.setZoom(null);
					}}
				>
					<Maximize />
				</IconButton>
			</div>
			<div class="group end">
				<IconButton
					label="New label"
					onclick={() => {
						editor.startBlank(editor.doc.tapeMm);
					}}><FilePlusCorner /></IconButton
				>
				<IconButton label="Save as template" disabled={empty} onclick={() => (saving = true)}
					><Save /></IconButton
				>
				<IconButton label="Keyboard shortcuts" onclick={() => (help = true)}
					><Keyboard /></IconButton
				>
			</div>
		</div>

		{#if showFields}
			<div class="template-bar">
				{#if editor.template}
					<p class="template-name">
						<LayoutGrid size={14} aria-hidden="true" />
						{editor.template.name}
						{#if editor.template.builtin}<span class="tag">Built-in</span>{/if}
					</p>
				{/if}
				<Fields />
			</div>
		{/if}

		<div class="canvas">
			<Canvas onedittext={editText} />
			{#if empty}
				<div class="empty">
					<p>Start from a template, or add your own text.</p>
					<div class="empty-actions">
						<Button variant="primary" onclick={() => goto(resolve("/templates"))}
							><LayoutGrid size={16} /> Templates</Button
						>
						<Button
							onclick={() => {
								editor.add("text");
								editText(editor.selection[0]);
							}}><Type size={16} /> Add text</Button
						>
					</div>
				</div>
			{/if}
		</div>
	</section>

	{#if wide.current}
		<aside class="side end-side"><EditPane /></aside>
	{:else}
		<section class="dock">
			<Panel wide={false} {tab} onchange={setTab} />
		</section>
	{/if}
</div>

{#snippet designIcon()}<PenLine />{/snippet}
{#snippet printIcon()}<Eye />{/snippet}

<PrintSheet bind:open={printing} doc={editor.doc} vars={editor.resolvedVars} {title} {lengthMm} />
<SaveTemplateSheet bind:open={saving} />
<ShortcutSheet bind:open={help} />

<style>
	.editor {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 340px;
		height: 100%;
	}

	.editor.wide {
		grid-template-columns: 280px minmax(0, 1fr) 320px;
	}

	.side,
	.dock {
		min-height: 0;
		overflow: auto;
		background: var(--panel);
	}

	.side {
		padding: 12px 16px 24px;
	}

	.start {
		box-shadow: 1px 0 0 var(--rule);
	}

	.end-side,
	.dock {
		box-shadow: -1px 0 0 var(--rule);
	}

	.dock {
		display: flex;
		flex-direction: column;
	}

	.work {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 16px;
		padding: 8px 12px;
	}

	.group {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.end {
		margin-inline-start: auto;
	}

	.zoom-value {
		min-width: 48px;
		padding: 4px;
		border: 0;
		border-radius: var(--r);
		background: none;
		color: var(--ink-2);
		font-size: 12px;
		cursor: pointer;
	}

	.zoom-value:hover {
		background: var(--hover);
	}

	.template-bar {
		display: grid;
		gap: 8px;
		margin: 0 12px;
		padding: 12px;
		border-radius: var(--r);
		background: var(--sunken);
		animation: enter var(--base) var(--ease);
	}

	.template-name {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--ink-2);
		font-size: 12px;
		font-weight: 500;
	}

	.tag {
		padding: 1px 6px;
		border-radius: var(--r);
		background: var(--panel);
		color: var(--ink-3);
		font-size: 11px;
	}

	.canvas {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.empty {
		position: absolute;
		inset-inline: 0;
		bottom: 24px;
		display: grid;
		justify-items: center;
		gap: 12px;
		color: var(--ink-2);
		pointer-events: none;
		animation: enter var(--slow) var(--ease);
	}

	.empty-actions {
		display: flex;
		gap: 8px;
		pointer-events: auto;
	}

	.length {
		padding-inline-start: 8px;
		margin-inline-start: 2px;
		box-shadow: -1px 0 0 color-mix(in oklch, var(--on-accent) 35%, transparent);
		font-weight: 400;
		opacity: 0.9;
	}

	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}

	@media (max-width: 760px) {
		.editor {
			display: flex;
			flex-direction: column;
			height: auto;
			min-height: 100%;
		}

		.work {
			flex: none;
		}

		.canvas {
			flex: none;
			height: clamp(200px, 36dvh, 320px);
		}

		.toolbar {
			gap: 4px 8px;
			padding: 8px;
		}

		.zoom {
			display: none;
		}

		.dock {
			flex: 1;
			overflow: visible;
			border-start-start-radius: var(--r-sheet);
			border-start-end-radius: var(--r-sheet);
			box-shadow: 0 -1px 0 var(--rule);
		}

		.empty {
			bottom: 12px;
		}
	}
</style>
