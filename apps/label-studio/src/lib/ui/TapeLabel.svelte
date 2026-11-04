<script lang="ts">
	import { dotsToMm, tapeGeometry, type LabelDoc, type Vars } from "$lib/doc";

	import Dimension from "./Dimension.svelte";
	import { LiveRender, paint } from "./render.svelte";
	import Skeleton from "./Skeleton.svelte";
	import { tapeAcross } from "./tape";

	/** A rendered label on its tape strip, at true proportion, with its length dimensioned. */
	let {
		doc,
		vars = {},
		mode = "design",
		maxWidth = 320,
		maxHeight = 72,
		dimension = true,
		lazy = false,
		alongTape = false,
		onlength,
	}: {
		doc: LabelDoc;
		vars?: Vars;
		mode?: "design" | "print";
		maxWidth?: number;
		maxHeight?: number;
		dimension?: boolean;
		lazy?: boolean;
		/**
		 * Lay an upright design along the tape, as it comes out of the printer, so a thumbnail of a
		 * tall label is as large as a wide one.
		 */
		alongTape?: boolean;
		onlength?: (dots: number) => void;
	} = $props();

	const live = new LiveRender();
	let canvas = $state<HTMLCanvasElement>();
	let host = $state<HTMLElement>();
	let visible = $state(false);

	const scale = $derived(
		mode === "print" ? 1 : Math.min(4, Math.ceil(2 * (globalThis.devicePixelRatio || 1))),
	);
	const upright = $derived(doc.orientation === "vertical");
	/** Upright and laid down: the canvas turns a quarter, counter-clockwise like the print raster. */
	const turned = $derived(upright && alongTape);
	const horizontal = $derived(!upright || alongTape);
	const across = $derived(tapeAcross(doc.tapeMm));
	const result = $derived(live.result);
	const frameW = $derived(result ? result.frame.width / (mode === "print" ? 1 : scale) : 0);
	const frameH = $derived(result ? result.frame.height / (mode === "print" ? 1 : scale) : 0);
	const along = $derived(upright ? frameH : frameW);
	// The tape runs across the screen for a horizontal label and down it for a vertical one.
	const zoom = $derived.by(() => {
		if (along <= 0) {
			return 1;
		}

		return horizontal
			? Math.min(maxWidth / along, maxHeight / across.dots, 4)
			: Math.min(maxWidth / across.dots, maxHeight / along, 4);
	});

	$effect(() => {
		if (!lazy) {
			visible = true;

			return;
		}

		if (!host) {
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					visible = true;
					observer.disconnect();
				}
			},
			{ rootMargin: "200px" },
		);

		observer.observe(host);

		return () => {
			observer.disconnect();
		};
	});

	$effect(() => {
		if (visible) {
			live.request(doc, { tape: tapeGeometry(doc.tapeMm), vars, mode, scale });
		}
	});

	$effect(() => {
		if (result && canvas) {
			paint(canvas, result.frame, [22, 22, 22]);
			onlength?.(result.lengthDots);
		}
	});

	$effect(() => () => {
		live.dispose();
	});
</script>

<figure class="tape-label" bind:this={host}>
	{#if result}
		<div
			class="strip"
			class:vertical={!horizontal}
			style:--gutter="{across.gutter * zoom}px"
			style:width="{(horizontal ? along : across.dots) * zoom}px"
			style:height="{(horizontal ? across.dots : along) * zoom}px"
		>
			<canvas
				bind:this={canvas}
				class:pixelated={mode === "print"}
				class:turned
				style:width="{frameW * zoom}px"
				style:height="{frameH * zoom}px"
			></canvas>
		</div>
		{#if dimension}
			<div class="dim" style:width="{(horizontal ? along : across.dots) * zoom}px">
				<Dimension mm={dotsToMm(result.lengthDots)} size="sm" />
			</div>
		{/if}
	{:else if live.error}
		<div class="failed" style:height="{maxHeight}px">Preview failed</div>
	{:else}
		<Skeleton width="{Math.min(maxWidth, maxHeight * 4)}px" height="{maxHeight * 0.8}px" />
	{/if}
</figure>

<style>
	.tape-label {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		margin: 0;
	}

	.strip {
		position: relative;
		display: grid;
		place-items: center;
		border-radius: 1px;
		background: linear-gradient(180deg, var(--tape) 0%, var(--tape-shade) 100%);
		box-shadow: var(--tape-shadow);
	}

	.strip.vertical {
		background: linear-gradient(90deg, var(--tape) 0%, var(--tape-shade) 100%);
	}

	canvas {
		display: block;
	}

	.turned {
		position: absolute;
		top: 50%;
		left: 50%;
		translate: -50% -50%;
		rotate: -90deg;
	}

	.pixelated {
		image-rendering: pixelated;
	}

	.failed {
		display: grid;
		place-items: center;
		color: var(--danger);
		font-size: 12px;
	}
</style>
