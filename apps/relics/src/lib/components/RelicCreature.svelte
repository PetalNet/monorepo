<script lang="ts">
	import { untrack } from "svelte";

	import type { CreatureViewer } from "../creature-viewer.ts";
	import { creatureModels, type CreatureModelId } from "../creatures.ts";
	import RelicPhoto from "./RelicPhoto.svelte";

	let {
		modelId,
		color,
		src: imageUrl,
		alt,
	}: {
		modelId: CreatureModelId | null;
		color: string | null;
		src: string | null;
		alt: string;
	} = $props();
	let canvas: HTMLCanvasElement | undefined = $state();
	let viewer = $state.raw<CreatureViewer | null>(null);
	let ready = $state(false);
	let failed = $state(false);
	let photo = $state(false);
	let paused = $state(false);
	let failedSrc = $state<string | null>(null);
	let presentation = $derived(modelId ? creatureModels[modelId] : null);
	let showingScene = $derived(ready && !failed && !photo);

	$effect(() => {
		const target = canvas;
		const model = modelId ? creatureModels[modelId] : null;

		if (!target || !model) {
			return;
		}

		const initialColor = untrack(() => color);
		const abort = new AbortController();
		const cancelled = () => abort.signal.aborted;
		let current: CreatureViewer | null = null;
		let idle: number | undefined;
		let firstFrame = 0;
		let secondFrame = 0;
		let deadline: ReturnType<typeof setTimeout> | undefined;

		ready = false;
		failed = false;
		photo = false;
		paused = false;

		const fail = () => {
			if (abort.signal.aborted) {
				return;
			}

			failed = true;
			ready = false;
			photo = false;
			abort.abort();
			current?.dispose();
			viewer = null;
		};

		const start = async () => {
			if (abort.signal.aborted) {
				return;
			}

			try {
				const { createCreatureViewer } = await import("../creature-viewer.ts");

				if (cancelled()) {
					return;
				}

				current = createCreatureViewer({
					canvas: target,
					model,
					color: initialColor,
					signal: abort.signal,
					onReady: () => {
						if (abort.signal.aborted) {
							return;
						}

						clearTimeout(deadline);
						ready = true;
					},
					onError: fail,
				});

				viewer = current;
			} catch {
				fail();
			}
		};

		firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => {
				deadline = setTimeout(fail, 10_000);

				if ("requestIdleCallback" in window) {
					idle = window.requestIdleCallback(() => void start(), { timeout: 500 });
				} else {
					void start();
				}
			});
		});

		return () => {
			abort.abort();
			cancelAnimationFrame(firstFrame);
			cancelAnimationFrame(secondFrame);

			if (idle !== undefined) {
				window.cancelIdleCallback(idle);
			}

			clearTimeout(deadline);
			current?.dispose();
			viewer = null;
		};
	});
	$effect(() => {
		viewer?.setColor(color);
	});
	$effect(() => {
		viewer?.setActive(showingScene);
	});
	$effect(() => {
		viewer?.setPaused(paused);
	});
</script>

{#key modelId}
	{#if presentation === null}
		<RelicPhoto src={imageUrl} {alt} />
	{:else}
		<div class="creature">
			<div
				class="stage"
				role={showingScene ? "application" : undefined}
				aria-label={showingScene ? "3D creature viewer" : undefined}
			>
				<div class="photo" hidden={showingScene}>
					{#if photo}
						<RelicPhoto src={imageUrl} {alt} />
					{:else if imageUrl && imageUrl !== failedSrc}
						<img src={imageUrl} {alt} onerror={() => (failedSrc = imageUrl)} />
					{:else}
						<div class="still">
							<img
								src={presentation.still}
								alt={`${presentation.label} in a woodland clearing. 3D still preview; color may differ.`}
							/>
							<p>3D still preview. Color may differ.</p>
						</div>
					{/if}
				</div>
				<canvas
					bind:this={canvas}
					hidden={!showingScene}
					tabindex={showingScene ? 0 : -1}
					aria-hidden={!showingScene}
					aria-label={`${alt}. 3D view. Drag or use left and right arrow keys to turn; Home resets the view.`}
				></canvas>
			</div>
			{#if ready && !failed}
				<div class="controls">
					<button type="button" onclick={() => (photo = !photo)}
						>{photo ? "Back to 3D" : "See the real one"}</button
					>
					{#if !photo}
						<button type="button" aria-pressed={paused} onclick={() => (paused = !paused)}
							>{paused ? "Resume motion" : "Pause motion"}</button
						>
					{/if}
				</div>
			{/if}
			<span class="sr-only" role="status"
				>{failed
					? imageUrl && imageUrl !== failedSrc
						? "3D couldn't open. The real photo is shown instead."
						: "3D couldn't open. A 3D still preview is shown instead; its color may differ."
					: ""}</span
			>
		</div>
	{/if}
{/key}

<style>
	.creature {
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		inline-size: 100%;
		block-size: 100%;
		min-inline-size: 0;
		border-radius: inherit;
		background: #fbf5e7;
	}
	.stage {
		position: relative;
		min-block-size: 0;
		border-radius: inherit;
	}
	.photo,
	canvas {
		inline-size: 100%;
		block-size: 100%;
		border-radius: inherit;
	}
	.photo :global(img) {
		object-fit: contain;
	}
	.photo > img,
	.still img {
		display: block;
		inline-size: 100%;
		block-size: 100%;
		border-radius: inherit;
	}
	.still {
		display: flex;
		flex-direction: column;
		block-size: 100%;
	}
	.still img {
		flex: 1;
		min-block-size: 0;
	}
	.still p {
		font: 18px/1.3 var(--font-note);
		text-align: center;
		color: var(--muted);
	}
	canvas {
		display: block;
		touch-action: pan-y;
		cursor: grab;
	}
	canvas:active {
		cursor: grabbing;
	}
	[hidden] {
		display: none;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0 8px;
	}
	button {
		min-block-size: 44px;
		min-inline-size: 44px;
		padding: 8px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--ink, #423e2f);
		font: inherit;
		cursor: pointer;
		transition: background-color 120ms ease;
	}
	button:hover,
	button:active {
		background: var(--sage, #e7ead9);
	}
	button:focus-visible,
	canvas:focus-visible {
		outline: 3px solid var(--primary, #526444);
		outline-offset: -3px;
	}
	.sr-only {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (prefers-reduced-motion: reduce) {
		button {
			transition: none;
		}
	}
</style>
