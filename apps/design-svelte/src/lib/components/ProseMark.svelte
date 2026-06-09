<script lang="ts">
	import { onMount } from "svelte";

	import Icon from "./Icon.svelte";
	import { PM_SEED } from "../data";
	import { renderMd } from "../markdown";

	/**
	 * The themed ProseMark editor. Progressive enhancement: the read view is
	 * SSR-rendered markdown (renderMd) and paints instantly with no JS. The heavy
	 * editor bundle (~860KB) is dynamically imported on idle / first Edit click,
	 * so it never gates first paint. Read and edit share identical metrics so the
	 * swap doesn't shift a pixel.
	 */
	let doc = $state(PM_SEED);
	let mode = $state<"read" | "edit">("read");
	let readHtml = $state(renderMd(PM_SEED));

	let mount = $state<HTMLDivElement>();
	let readEl = $state<HTMLDivElement>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let view: any = null;

	let pmPromise: Promise<(el: HTMLElement, doc: string) => unknown> | null = null;
	function loadProseMark() {
		if (!pmPromise) {
			// The bundle is a static runtime asset under /vendor, marked external in
			// vite.config so the bundler leaves this import() untouched. Lazy: the
			// ~860KB editor never gates first paint.
			// @ts-expect-error — runtime-only vendored asset under /vendor, no types
			pmPromise = import(/* @vite-ignore */ "/vendor/prosemark.bundle.js").then(
				(m) => m.createProseMark,
			);
		}
		return pmPromise;
	}

	onMount(() => {
		// Warm the bundle once the browser goes idle (latency nicety).
		const ric =
			(window as unknown as { requestIdleCallback?: (fn: () => void) => void })
				.requestIdleCallback || ((fn: () => void) => setTimeout(fn, 1500));
		ric(() => loadProseMark().catch(() => {}));
	});

	async function ensureEditor() {
		if (view || !mount) return;
		try {
			const createProseMark = await loadProseMark();
			if (view) return;
			view = createProseMark(mount, doc);
		} catch (e) {
			if (mount)
				mount.innerHTML =
					'<div style="padding:18px 20px;color:var(--text-mute);font-size:13px">Editor failed to load.</div>';
			console.error("ProseMark mount failed", e);
		}
	}

	function showRead() {
		if (view) {
			try {
				doc = view.state.doc.toString();
			} catch {}
		}
		readHtml = renderMd(doc);
		mode = "read";
	}

	async function showEdit() {
		mode = "edit";
		await ensureEditor();
		if (view && view.state.doc.toString() !== doc) {
			try {
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
			} catch {}
		}
		if (view) {
			try {
				view.focus();
			} catch {}
		}
	}

	// Read-view copy buttons actually copy the code (bug-1 nice-to-have).
	function onReadClick(e: MouseEvent) {
		const btn = (e.target as HTMLElement).closest(".cm-code-block-copy-button");
		if (!btn) return;
		const code = btn.closest("pre")?.querySelector("code");
		if (!code) return;
		try {
			navigator.clipboard?.writeText(code.textContent ?? "");
		} catch {}
	}
</script>

<div class="pm-shell settle mt-14" id="pm-shell">
	<div class="pm-bar">
		<span class="pm-ico" aria-hidden="true"><Icon name="square-pen" /></span>
		<span class="pm-label">Editor</span>
		<div class="pm-toggle" id="pm-toggle" role="group" aria-label="Read or edit">
			<button type="button" id="pm-read-btn" aria-pressed={mode === "read"} onclick={showRead}>
				Read
			</button>
			<button type="button" id="pm-edit-btn" aria-pressed={mode === "edit"} onclick={showEdit}>
				Edit
			</button>
		</div>
	</div>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<div
		class="pm-pane pm-rendered"
		id="pm-read"
		bind:this={readEl}
		hidden={mode !== "read"}
		onclick={onReadClick}
		role="presentation">
		{@html readHtml}
	</div>
	<div class="pm-pane" id="pm-edit" hidden={mode !== "edit"}><div id="pm-mount" bind:this={mount}></div></div>
</div>
