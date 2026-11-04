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
	import PrintButton from "$lib/ui/PrintButton.svelte";
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
		Redo2,
		Save,
		Type,
		Undo2,
	} from "@lucide/svelte";
	import { MediaQuery } from "svelte/reactivity";

	/** CSS pixels per printer dot at real size: 96 CSS px per inch over 180 dots per inch. */
	const ACTUAL_SIZE = 96 / 180;
	const wide = new MediaQuery("min-width: 1100px");
	/* On a phone the label leads and its fields follow it; above that, fill-in-the-blanks come first. */
	const phone = new MediaQuery("max-width: 760px");
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

	// Installed after mount, so it lands after the previous page's cleanup.
	$effect(() => {
		chrome.actions = printAction;

		return () => {
			if (chrome.actions === printAction) {
				chrome.actions = null;
			}
		};
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
			const element = createElement(editor.doc, "text", editor.boxes);

			editor.insert({ ...element, ...(element.kind === "text" ? { text } : {}) });
		}
	}
</script>

<svelte:window onkeydown={keydown} onpaste={paste} />

{#snippet printAction()}
	<PrintButton disabled={empty} onclick={() => (printing = true)}
		>{formatMm(lengthMm)} mm</PrintButton
	>
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
				{#if !phone.current}
					<IconButton label="Keyboard shortcuts" onclick={() => (help = true)}
						><Keyboard /></IconButton
					>
				{/if}
			</div>
		</div>

		{#if showFields && !phone.current}<Fields />{/if}

		<div class="canvas" class:empty>
			<Canvas onedittext={editText} blank={start} />
		</div>

		{#if showFields && phone.current}<Fields />{/if}
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
{#snippet start()}
	<div class="first-run">
		<p>Start from a template, or add your own text.</p>
		<div class="first-run-actions">
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
{/snippet}

{#snippet printIcon()}<Eye />{/snippet}

<PrintSheet bind:open={printing} doc={editor.doc} vars={editor.resolvedVars} {title} {lengthMm} />
<SaveTemplateSheet bind:open={saving} />
<ShortcutSheet bind:open={help} />

<style>
	.editor {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 340px;
		height: calc(100dvh - var(--bar-h) - var(--banner-h, 0px));
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

	.canvas {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.first-run {
		display: grid;
		justify-items: center;
		gap: 12px;
		width: max-content;
		padding-top: 14px;
		color: var(--ink-2);
		animation: enter var(--slow) var(--ease);
	}

	.first-run p {
		margin: 0;
	}

	.first-run-actions {
		display: flex;
		gap: 8px;
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
		}

		.work {
			flex: none;
		}

		.canvas {
			flex: none;
			height: clamp(180px, 30dvh, 280px);
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

		/* The first thing a phone shows: give the blank tape and its prompt room to breathe. */
		.canvas.empty {
			height: clamp(280px, 40dvh, 360px);
		}
	}
</style>
