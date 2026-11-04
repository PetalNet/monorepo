<script lang="ts">
	import Banner from "$lib/ui/Banner.svelte";
	import {
		Barcode,
		ChevronLeft,
		Circle,
		Grid2x2,
		ImagePlus,
		Minus,
		QrCode,
		RectangleHorizontal,
		ScanBarcode,
		Smile,
		Square,
		SquareDashed,
		Type,
	} from "@lucide/svelte";
	import type { Component } from "svelte";

	import { editor } from "./editor.svelte";
	import IconPicker from "./IconPicker.svelte";
	import { insertImage } from "./insert-image";
	import { createElement, type AddKind } from "./model";

	let { onadded }: { onadded?: () => void } = $props();

	let picking = $state(false);
	let imageError = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement>();

	const groups: {
		title: string;
		items: { kind: AddKind | "image" | "ellipse"; label: string; icon: Component }[];
	}[] = [
		{
			title: "Content",
			items: [
				{ kind: "text", label: "Text", icon: Type },
				{ kind: "icon", label: "Icon", icon: Smile },
				{ kind: "image", label: "Image", icon: ImagePlus },
			],
		},
		{
			title: "Shapes",
			items: [
				{ kind: "line", label: "Line", icon: Minus },
				{ kind: "rect", label: "Rectangle", icon: Square },
				{ kind: "rounded", label: "Rounded", icon: RectangleHorizontal },
				{ kind: "frame", label: "Frame", icon: SquareDashed },
				{ kind: "ellipse", label: "Ellipse", icon: Circle },
			],
		},
		{
			title: "Codes",
			items: [
				{ kind: "qr", label: "QR", icon: QrCode },
				{ kind: "code128", label: "Code 128", icon: Barcode },
				{ kind: "datamatrix", label: "Data Matrix", icon: Grid2x2 },
				{ kind: "ean13", label: "EAN-13", icon: ScanBarcode },
			],
		},
	];

	function add(kind: AddKind | "image" | "ellipse"): void {
		if (kind === "image") {
			fileInput?.click();

			return;
		}

		if (kind === "icon") {
			picking = true;

			return;
		}

		if (kind === "ellipse") {
			const shape = createElement(editor.doc, "rect", editor.boxes);

			editor.insert({ ...shape, ...(shape.kind === "shape" ? { shape: "ellipse" as const } : {}) });
		} else {
			editor.add(kind);
		}

		onadded?.();
	}

	async function addImage(blob: Blob): Promise<void> {
		imageError = null;

		try {
			await insertImage(blob);
			onadded?.();
		} catch {
			imageError = "That file is not an image this browser can read. Try a PNG or JPEG.";
		}
	}
</script>

<input
	bind:this={fileInput}
	class="sr-only"
	type="file"
	accept="image/*"
	tabindex="-1"
	onchange={(event) => {
		const file = event.currentTarget.files?.[0];

		if (file) {
			void addImage(file);
		}

		event.currentTarget.value = "";
	}}
/>

{#if picking}
	<div class="picking">
		<button class="back" type="button" onclick={() => (picking = false)}
			><ChevronLeft size={16} /> Add</button
		>
		<IconPicker
			onpick={(name: string) => {
				const icon = createElement(editor.doc, "icon", editor.boxes);

				editor.insert({ ...icon, ...(icon.kind === "icon" ? { icon: name } : {}) });
				picking = false;
				onadded?.();
			}}
		/>
	</div>
{:else}
	<div class="groups">
		{#each groups as group (group.title)}
			<section>
				<h3>{group.title}</h3>
				<div class="tiles">
					{#each group.items as item (item.kind)}
						<button
							type="button"
							class="tile"
							onclick={() => {
								add(item.kind);
							}}
						>
							<item.icon aria-hidden="true" />
							<span>{item.label}</span>
						</button>
					{/each}
				</div>
			</section>
		{/each}
		<p class="hint">Paste an image anywhere to add it.</p>
		{#if imageError}<Banner tone="danger">{imageError}</Banner>{/if}
	</div>
{/if}

<style>
	.groups {
		display: grid;
		gap: 16px;
	}

	h3 {
		margin-bottom: 8px;
		color: var(--ink-3);
		font-size: 12px;
		font-weight: 500;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
		gap: 4px;
	}

	.tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 64px;
		border: 0;
		border-radius: var(--r);
		background: var(--sunken);
		color: var(--ink);
		font-size: 12px;
		cursor: pointer;
		transition:
			background-color var(--fast),
			transform var(--fast) var(--ease-standard);
	}

	.tile:hover {
		background: color-mix(in oklch, var(--sunken), var(--ink) 6%);
	}

	.tile:active {
		transform: scale(0.96);
	}

	.tile :global(svg) {
		width: 20px;
		height: 20px;
		stroke-width: 1.6;
		color: var(--ink-2);
	}

	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}

	.picking {
		display: grid;
		gap: 8px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		justify-self: start;
		padding: 4px 6px 4px 0;
		border: 0;
		background: none;
		color: var(--ink-2);
		cursor: pointer;
	}
</style>
