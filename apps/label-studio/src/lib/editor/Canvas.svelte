<script lang="ts">
	import { dotsToMm, mmToDots, tapeGeometry, type Box, type LabelElement } from "$lib/doc";
	import Dimension from "$lib/ui/Dimension.svelte";
	import { LiveRender, paint } from "$lib/ui/render.svelte";
	import Skeleton from "$lib/ui/Skeleton.svelte";
	import { tapeAcross, tapeMmActual } from "$lib/ui/tape";
	import { SvelteMap } from "svelte/reactivity";

	import { editor } from "./editor.svelte";
	import { frameSize, mapElements, unionBox } from "./model";
	import {
		HANDLES,
		resizeBox,
		snapBox,
		snapResize,
		snapTargets,
		type Guide,
		type Handle,
	} from "./snap";

	let { onedittext }: { onedittext?: (id: string) => void } = $props();

	const live = new LiveRender();
	const MAX_CANVAS = 8192;
	const SNAP_PX = 6;

	let stage = $state<HTMLElement>();
	let overlay = $state<HTMLElement>();
	let canvas = $state<HTMLCanvasElement>();
	let stageSize = $state({ w: 0, h: 0 });
	let guides = $state<Guide[]>([]);
	let dpr = $state(globalThis.devicePixelRatio || 1);
	let renderedScale = $state(1);

	const doc = $derived(editor.doc);
	const horizontal = $derived(doc.orientation === "horizontal");
	const zoom = $derived(editor.effectiveZoom);
	const across = $derived(tapeAcross(doc.tapeMm));
	const result = $derived(live.result);
	const printView = $derived(editor.view === "print");
	/**
	 * Pixels per dot in the bitmap: zoom × devicePixelRatio, capped so a long label stays a legal
	 * canvas.
	 */
	const scale = $derived.by(() => {
		if (printView) {
			return 1;
		}

		const along = Math.max(editor.lengthDots, 200);
		const wanted = Math.ceil(zoom * dpr);

		return Math.max(1, Math.min(wanted, 16, Math.floor(MAX_CANVAS / along)));
	});
	const frame = $derived(
		result
			? {
					w: result.frame.width / (printView ? 1 : renderedScale),
					h: result.frame.height / (printView ? 1 : renderedScale),
				}
			: frameSize(doc, mmToDots(30)),
	);

	// Fit the label in the stage with room for the dimension lines.
	$effect(() => {
		const alongDots = horizontal ? frame.w : frame.h;
		const acrossDots = across.dots;

		if (stageSize.w === 0 || alongDots <= 0) {
			return;
		}

		const roomAlong = (horizontal ? stageSize.w : stageSize.h) - 96;
		const roomAcross = (horizontal ? stageSize.h : stageSize.w) - 112;

		editor.fitZoom = Math.max(0.5, Math.min(roomAlong / alongDots, roomAcross / acrossDots, 12));
	});

	$effect(() => {
		const options = {
			tape: tapeGeometry(doc.tapeMm),
			vars: editor.resolvedVars,
			mode: editor.view,
			scale,
		};

		live.request(doc, options);
	});

	$effect(() => {
		if (!result || !canvas) {
			return;
		}

		renderedScale = printView
			? 1
			: result.frame.width / Math.max(1, frameSize(doc, result.lengthDots).w);

		paint(canvas, result.frame, [22, 22, 22]);
		editor.boxes = result.boxes;
		editor.lengthDots = result.lengthDots;
		editor.warnings = result.warnings;
	});

	$effect(() => {
		if (!stage) {
			return;
		}

		const observer = new ResizeObserver(([entry]) => {
			stageSize = { w: entry.contentRect.width, h: entry.contentRect.height };
		});

		observer.observe(stage);
		const media = matchMedia(`(resolution: ${String(dpr)}dppx)`);
		const onDpr = (): void => {
			dpr = globalThis.devicePixelRatio || 1;
		};

		media.addEventListener("change", onDpr);

		return () => {
			observer.disconnect();
			media.removeEventListener("change", onDpr);
		};
	});

	$effect(() => () => {
		live.dispose();
	});

	const boxOf = (element: LabelElement): Box => editor.boxes[element.id] ?? element;
	const selectedSet = $derived(new Set(editor.selection));
	const single = $derived(editor.selected.length === 1 ? editor.selected[0] : null);
	const selectionBox = $derived(unionBox(editor.selected.map(boxOf)));
	const keepsRatio = (element: LabelElement): boolean =>
		element.kind === "icon" ||
		(element.kind === "code" && (element.symbology === "qr" || element.symbology === "datamatrix"));

	// Pointer gestures: one pointer drags or resizes, two pointers pinch-zoom.
	const pointers = new SvelteMap<number, { x: number; y: number }>();
	let gesture:
		| {
				kind: "move";
				start: { x: number; y: number };
				origin: Record<string, Box>;
				key: string;
				moved: boolean;
		  }
		| {
				kind: "resize";
				handle: Handle;
				start: { x: number; y: number };
				origin: Box;
				id: string;
				key: string;
		  }
		| { kind: "pinch"; distance: number; zoom: number }
		| null = null;
	let lastTap = { id: "", at: 0 };

	function toDots(event: PointerEvent): { x: number; y: number } {
		const rect = overlay?.getBoundingClientRect();

		return rect
			? { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom }
			: { x: 0, y: 0 };
	}

	function hit(point: { x: number; y: number }): LabelElement | null {
		const pad = 6 / zoom;

		for (const element of doc.elements.toReversed()) {
			const box = boxOf(element);

			if (
				point.x >= box.x - pad &&
				point.x <= box.x + box.w + pad &&
				point.y >= box.y - pad &&
				point.y <= box.y + box.h + pad
			) {
				return element;
			}
		}

		return null;
	}

	function targetsExcept(ids: ReadonlySet<string>) {
		const others = doc.elements.filter((element) => !ids.has(element.id)).map(boxOf);
		const end = doc.length.mode === "fixed" ? mmToDots(doc.length.mm - doc.margin.endMm) : null;

		return snapTargets(
			frame,
			{ start: mmToDots(doc.margin.startMm), end },
			others,
			horizontal ? "x" : "y",
		);
	}

	function pinchDistance(): number {
		const [a, b] = [...pointers.values()];

		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	function pointerdown(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}

		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

		if (pointers.size === 2) {
			gesture = { kind: "pinch", distance: pinchDistance(), zoom };

			return;
		}

		const point = toDots(event);
		const handle = (event.target as HTMLElement).dataset.handle as Handle | undefined;

		if (handle && single && !single.locked) {
			gesture = {
				kind: "resize",
				handle,
				start: point,
				origin: boxOf(single),
				id: single.id,
				key: `resize:${String(event.timeStamp)}`,
			};

			stage?.setPointerCapture(event.pointerId);
			event.preventDefault();

			return;
		}

		const element = hit(point);

		if (!element) {
			if (!event.shiftKey) {
				editor.select([]);
			}

			return;
		}

		const now = event.timeStamp;

		if (lastTap.id === element.id && now - lastTap.at < 350 && element.kind === "text") {
			onedittext?.(element.id);
			lastTap = { id: "", at: 0 };

			return;
		}

		lastTap = { id: element.id, at: now };

		if (event.shiftKey || event.metaKey || event.ctrlKey) {
			editor.toggleSelect(element.id);
		} else if (!selectedSet.has(element.id)) {
			editor.select([element.id]);
		}

		const origin = Object.fromEntries(
			editor.selected.map((selected) => [selected.id, { ...selected }]),
		);

		gesture = { kind: "move", start: point, origin, key: `move:${String(now)}`, moved: false };
		stage?.setPointerCapture(event.pointerId);
		event.preventDefault();
	}

	function pointermove(event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) {
			return;
		}

		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

		if (!gesture) {
			return;
		}

		if (gesture.kind === "pinch") {
			if (pointers.size === 2) {
				editor.setZoom((gesture.zoom * pinchDistance()) / gesture.distance);
			}

			return;
		}

		const point = toDots(event);
		const dx = point.x - gesture.start.x;
		const dy = point.y - gesture.start.y;
		const threshold = SNAP_PX / zoom;

		if (gesture.kind === "move") {
			if (!gesture.moved && Math.hypot(dx, dy) * zoom < 3) {
				return;
			}

			gesture.moved = true;
			const origin = gesture.origin;
			const movable = Object.values(origin).filter((element) => !(element as LabelElement).locked);
			const box = unionBox(movable);

			if (!box) {
				return;
			}

			const moved = { ...box, x: box.x + dx, y: box.y + dy };
			const snapped = event.altKey
				? { box: { ...moved, x: Math.round(moved.x), y: Math.round(moved.y) }, guides: [] }
				: snapBox(moved, targetsExcept(new Set(Object.keys(origin))), threshold);

			guides = snapped.guides;
			const offsetX = snapped.box.x - box.x;
			const offsetY = snapped.box.y - box.y;

			editor.apply(
				mapElements(doc, Object.keys(origin), (element) =>
					element.locked
						? element
						: { ...element, x: origin[element.id].x + offsetX, y: origin[element.id].y + offsetY },
				),
				gesture.key,
			);

			return;
		}

		const id = gesture.id;
		const element = doc.elements.find((candidate) => candidate.id === id);

		if (!element) {
			return;
		}

		const resized = resizeBox(
			gesture.origin,
			gesture.handle,
			dx,
			dy,
			keepsRatio(element) || event.shiftKey,
		);
		const snapped = event.altKey
			? { box: resized, guides: [] }
			: snapResize(resized, gesture.handle, targetsExcept(new Set([element.id])), threshold);

		guides = snapped.guides;
		const patch: Partial<LabelElement> = { ...snapped.box };

		if (element.kind === "text" && gesture.handle !== "n" && gesture.handle !== "s") {
			Object.assign(patch, { widthMode: "fixed" });
		}

		editor.apply(
			mapElements(doc, [element.id], (current) => ({ ...current, ...patch }) as LabelElement),
			gesture.key,
		);
	}

	function pointerup(event: PointerEvent): void {
		pointers.delete(event.pointerId);

		if (pointers.size < 2 && gesture?.kind === "pinch") {
			gesture = null;
		}

		if (pointers.size === 0) {
			gesture = null;
			guides = [];
		}
	}

	function wheel(event: WheelEvent): void {
		if (event.ctrlKey || event.metaKey) {
			event.preventDefault();
			editor.zoomBy(Math.exp(-event.deltaY * 0.01));
		}
	}

	const marginStart = $derived(mmToDots(doc.margin.startMm));
	const marginEnd = $derived(
		doc.length.mode === "fixed" ? mmToDots(doc.length.mm) - mmToDots(doc.margin.endMm) : null,
	);
	const stripW = $derived((horizontal ? frame.w : across.dots) * zoom);
	const stripH = $derived((horizontal ? across.dots : frame.h) * zoom);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="stage"
	bind:this={stage}
	onpointerdown={pointerdown}
	onpointermove={pointermove}
	onpointerup={pointerup}
	onpointercancel={pointerup}
	onwheel={wheel}
>
	<div class="layout" class:vertical={!horizontal}>
		<div class="row">
			<div
				class="strip"
				class:vertical={!horizontal}
				class:printing={printView}
				style:width="{stripW}px"
				style:height="{stripH}px"
			>
				{#if !result}
					<div class="loading"><Skeleton width="60%" height="40%" /></div>
				{/if}
				<div
					class="frame"
					bind:this={overlay}
					style:width="{frame.w * zoom}px"
					style:height="{frame.h * zoom}px"
					style:--zoom={zoom}
				>
					<canvas
						bind:this={canvas}
						class:pixelated={printView}
						style:width="{frame.w * zoom}px"
						style:height="{frame.h * zoom}px"
						aria-label="Label preview, {printView ? 'print view' : 'design view'}"
					></canvas>

					{#if !printView}
						<span
							class="margin"
							style:left={horizontal ? `${String(marginStart * zoom)}px` : "0"}
							style:top={horizontal ? "0" : `${String(marginStart * zoom)}px`}
							class:across={!horizontal}
						></span>
						{#if marginEnd !== null}
							<span
								class="margin"
								style:left={horizontal ? `${String(marginEnd * zoom)}px` : "0"}
								style:top={horizontal ? "0" : `${String(marginEnd * zoom)}px`}
								class:across={!horizontal}
							></span>
						{/if}
					{/if}

					{#each doc.elements as element (element.id)}
						{@const box = boxOf(element)}
						{#if selectedSet.has(element.id)}
							<div
								class="selection"
								class:locked={element.locked}
								style:left="{box.x * zoom}px"
								style:top="{box.y * zoom}px"
								style:width="{box.w * zoom}px"
								style:height="{box.h * zoom}px"
							></div>
						{/if}
					{/each}

					{#if single && !single.locked && !printView}
						{@const box = boxOf(single)}
						{#each HANDLES as handle (handle)}
							<span
								class="handle {handle}"
								data-handle={handle}
								style:left="{(box.x +
									(handle.includes('w') ? 0 : handle.includes('e') ? box.w : box.w / 2)) *
									zoom}px"
								style:top="{(box.y +
									(handle.includes('n') ? 0 : handle.includes('s') ? box.h : box.h / 2)) *
									zoom}px"
							></span>
						{/each}
					{/if}

					{#if selectionBox && editor.selected.length > 1}
						<div
							class="group"
							style:left="{selectionBox.x * zoom}px"
							style:top="{selectionBox.y * zoom}px"
							style:width="{selectionBox.w * zoom}px"
							style:height="{selectionBox.h * zoom}px"
						></div>
					{/if}

					{#each guides as guide, index (index)}
						<span
							class="guide {guide.axis}"
							style:left={guide.axis === "x" ? `${String(guide.at * zoom)}px` : undefined}
							style:top={guide.axis === "y" ? `${String(guide.at * zoom)}px` : undefined}
						></span>
					{/each}
				</div>
			</div>
			<div class="dim-across" style:height="{stripH}px">
				<Dimension
					mm={tapeMmActual(doc.tapeMm)}
					axis="y"
					label="Tape width {tapeMmActual(doc.tapeMm)} mm"
				/>
			</div>
		</div>
		<div class="dim-along" style:width="{stripW}px">
			<Dimension
				mm={dotsToMm(editor.lengthDots)}
				axis={horizontal ? "x" : "y"}
				label="Label length {dotsToMm(editor.lengthDots).toFixed(1)} mm"
			/>
		</div>
	</div>
</div>

<style>
	.stage {
		position: relative;
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		overflow: auto;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	}

	.layout {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		padding: 40px 48px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.strip {
		position: relative;
		display: grid;
		place-items: center;
		border-radius: 2px;
		background: linear-gradient(180deg, var(--tape) 0%, var(--tape-shade) 100%);
		box-shadow: var(--tape-shadow);
		transition:
			width var(--base) var(--ease),
			height var(--base) var(--ease);
	}

	.strip.vertical {
		background: linear-gradient(90deg, var(--tape) 0%, var(--tape-shade) 100%);
	}

	.loading {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
	}

	.frame {
		position: relative;
		cursor: default;
	}

	canvas {
		position: absolute;
		inset: 0;
		display: block;
	}

	.pixelated {
		image-rendering: pixelated;
	}

	.margin {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 0;
		border-inline-start: 1px dashed color-mix(in oklch, var(--accent) 45%, transparent);
		pointer-events: none;
	}

	.margin.across {
		inset-inline: 0;
		bottom: auto;
		width: auto;
		height: 0;
		border-inline-start: 0;
		border-top: 1px dashed color-mix(in oklch, var(--accent) 45%, transparent);
	}

	.selection {
		position: absolute;
		outline: 1.5px solid var(--accent);
		pointer-events: none;
		animation: settle var(--fast) var(--ease);
	}

	.selection.locked {
		outline-style: dashed;
		outline-color: var(--ink-3);
	}

	.group {
		position: absolute;
		outline: 1px dashed var(--accent);
		outline-offset: 3px;
		pointer-events: none;
	}

	.handle {
		position: absolute;
		z-index: 1;
		width: 9px;
		height: 9px;
		margin: -4.5px 0 0 -4.5px;
		border-radius: 1px;
		background: var(--sheet);
		box-shadow:
			0 0 0 1.5px var(--accent),
			0 1px 2px oklch(0 0 0 / 0.2);
		touch-action: none;
	}

	/* Thumb-sized hit target around a small visual. */
	.handle::after {
		content: "";
		position: absolute;
		inset: -10px;
	}

	@media (pointer: coarse) {
		.handle {
			width: 14px;
			height: 14px;
			margin: -7px 0 0 -7px;
			border-radius: 50%;
		}

		.handle::after {
			inset: -15px;
		}
	}

	.nw,
	.se {
		cursor: nwse-resize;
	}

	.ne,
	.sw {
		cursor: nesw-resize;
	}

	.n,
	.s {
		cursor: ns-resize;
	}

	.e,
	.w {
		cursor: ew-resize;
	}

	.guide {
		position: absolute;
		background: var(--danger);
		pointer-events: none;
	}

	.guide.x {
		top: -24px;
		bottom: -24px;
		width: 1px;
	}

	.guide.y {
		left: -24px;
		right: -24px;
		height: 1px;
	}

	.dim-across {
		display: flex;
	}

	@keyframes settle {
		from {
			outline-offset: 3px;
			opacity: 0;
		}
	}
</style>
