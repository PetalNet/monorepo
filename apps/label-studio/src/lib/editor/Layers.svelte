<script lang="ts">
	import type { LabelElement } from "$lib/doc";
	import {
		Barcode,
		Circle,
		GripVertical,
		Image,
		Lock,
		Minus,
		QrCode,
		Smile,
		Square,
		Type,
	} from "@lucide/svelte";
	import type { Component } from "svelte";
	import { flip } from "svelte/animate";

	import { editor } from "./editor.svelte";
	import { elementLabel, moveToIndex } from "./model";

	const layers = $derived(editor.doc.elements.toReversed());
	let dragging = $state<string | null>(null);

	function iconFor(element: LabelElement): Component {
		switch (element.kind) {
			case "text":
				return Type;
			case "icon":
				return Smile;
			case "image":
				return Image;
			case "code":
				return element.symbology === "qr" || element.symbology === "datamatrix" ? QrCode : Barcode;
			case "shape":
				return element.shape === "ellipse"
					? Circle
					: element.shape.startsWith("line")
						? Minus
						: Square;
		}
	}

	function dragOver(event: DragEvent, target: LabelElement): void {
		if (dragging === null || dragging === target.id) {
			return;
		}

		event.preventDefault();
		const index = editor.doc.elements.findIndex((element) => element.id === target.id);

		editor.apply(moveToIndex(editor.doc, dragging, index), `layers:${dragging}`);
	}
</script>

{#if layers.length === 0}
	<p class="empty">
		No elements yet. Add text, an icon or a code and it shows up here, top layer first.
	</p>
{:else}
	<ul class="layers" aria-label="Layers, top first">
		{#each layers as element (element.id)}
			{@const Icon = iconFor(element)}
			<li animate:flip={{ duration: 180 }}>
				<button
					type="button"
					class="layer"
					class:selected={editor.selection.includes(element.id)}
					class:dragging={dragging === element.id}
					aria-pressed={editor.selection.includes(element.id)}
					draggable="true"
					ondragstart={(event) => {
						dragging = element.id;
						event.dataTransfer?.setData("text/plain", element.id);
					}}
					ondragover={(event) => {
						dragOver(event, element);
					}}
					ondragend={() => (dragging = null)}
					onclick={(event) => {
						if (event.shiftKey || event.metaKey || event.ctrlKey) {
							editor.toggleSelect(element.id);
						} else {
							editor.select([element.id]);
						}
					}}
				>
					<GripVertical class="grip" aria-hidden="true" />
					<Icon aria-hidden="true" />
					<span class="name">{elementLabel(element)}</span>
					{#if element.locked}<Lock class="lock" aria-label="Locked" />{/if}
				</button>
			</li>
		{/each}
	</ul>
	<p class="hint">Drag to reorder. [ and ] move the selection.</p>
{/if}

<style>
	.layers {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.layer {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 36px;
		padding-inline: 4px 10px;
		border: 0;
		border-radius: var(--r);
		background: transparent;
		color: var(--ink);
		text-align: start;
		cursor: pointer;
		transition: background-color var(--fast);
	}

	@media (pointer: coarse) {
		.layer {
			height: 44px;
		}
	}

	.layer:hover {
		background: var(--hover);
	}

	.layer.selected {
		background: var(--accent-soft);
	}

	.layer.dragging {
		opacity: 0.5;
	}

	.layer :global(svg) {
		flex: none;
		width: 16px;
		height: 16px;
		color: var(--ink-2);
		stroke-width: 1.75;
	}

	.layer :global(.grip) {
		color: var(--ink-3);
		cursor: grab;
	}

	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty,
	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}

	.hint {
		margin-top: 8px;
	}
</style>
