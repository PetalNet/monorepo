<script lang="ts">
	import type { Snippet } from "svelte";
	import { onMount } from "svelte";
	import {
		dataMode,
		getAssistantSession,
		sendAssistantContext,
		sendAssistantMessage,
		type AssistantContextPayload,
	} from "$lib/api/client";
	import type { HealthVerdict } from "$lib/api/derive";
	import type { Me } from "$lib/api/types";
	import AskDock, { type ContextPayload } from "./AskDock.svelte";
	import CommandPalette from "./CommandPalette.svelte";
	import Icon from "./Icon.svelte";
	import Sidebar from "./Sidebar.svelte";
	import Snackbar from "./Snackbar.svelte";

	/**
	 * The one fixed frame, three regions (foundations §2.1): sidebar 232px + canvas.
	 * Collapses to a 56px icon rail below 1280px; single-column canvas below 1024px.
	 * The shell owns the one durable assistant dock and universal selected-context seam.
	 */
	interface Props {
		me: Me;
		verdict: HealthVerdict;
		stateFact?: string | null;
		badges?: Record<string, number | "down" | "p0" | "warn" | "muted" | null>;
		connected?: boolean;
		children: Snippet;
	}
	let {
		me,
		verdict,
		stateFact = null,
		badges = {},
		connected = true,
		children,
	}: Props = $props();

	let askRef = $state<AskDock | null>(null);
	let paletteOpen = $state(false);
	let context = $state<ContextPayload | null>(null);
	let progress = $state<string | null>(null);
	let transcript = $state<string | null>(null);
	let panels = $state<MaterializedPanel[]>([]);
	let windowLayout = $state<WindowLayout | null>(null);
	let sessionRestoring = $state(false);
	let assistantFailed = $state(false);
	let contextDelivery: Promise<void> | null = null;
	let menu = $state<{ x: number; y: number; target: HTMLElement } | null>(null);
	let menuEl = $state<HTMLDivElement | null>(null);
	const assistantDown = $derived(
		!connected || dataMode() !== "live" || assistantFailed,
	);

	type Scalar = string | number | boolean | null;
	interface MaterializedPanel {
		schema_version: 1;
		panel: {
			schema_version: 2;
			type:
				| "bar"
				| "line"
				| "stat"
				| "table"
				| "pie"
				| "scatter"
				| "gauge"
				| "heatmap"
				| "histogram"
				| "insight"
				| "text"
				| "refusal";
			title: string;
			description?: string | null;
			query_ref?: string | null;
			prose?: string | null;
			refusal?: { reason: string; suggestions?: string[] } | null;
			layout?: {
				span?: number;
				row?: number;
				col?: number;
				highlight?: boolean;
			} | null;
		};
		result: {
			columns: { name: string }[];
			rows: Scalar[][];
			row_count: number;
			query_ref?: string;
			freshness?: { source?: string; observed_at?: string };
		} | null;
		render: {
			selection_reason: string;
			data_query_ref: string | null;
			bindings?: { status: "resolved" | "refused" }[];
		};
	}
	interface WindowLayout {
		ops: {
			verb: string;
			panel_index?: number;
			layout?: Record<string, unknown>;
		}[];
	}

	function record(value: unknown): Record<string, unknown> | null {
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	}
	function materialized(value: unknown): MaterializedPanel | null {
		const candidate = record(value);
		if (!candidate) return null;
		const panel = record(candidate.panel),
			render = record(candidate.render);
		const panelTypes = [
			"bar",
			"line",
			"stat",
			"table",
			"pie",
			"scatter",
			"gauge",
			"heatmap",
			"histogram",
			"insight",
			"text",
			"refusal",
		];
		const result = candidate.result === null ? null : record(candidate.result);
		if (
			candidate.schema_version === 1 &&
			panel?.schema_version === 2 &&
			typeof panel.title === "string" &&
			panelTypes.includes(String(panel.type)) &&
			render &&
			(result === null ||
				(Array.isArray(result?.columns) && Array.isArray(result?.rows)))
		)
			return candidate as unknown as MaterializedPanel;
		for (const key of ["result", "output", "data"]) {
			const nested = candidate[key];
			if (typeof nested === "string") {
				try {
					const parsed = materialized(JSON.parse(nested));
					if (parsed) return parsed;
				} catch {
					/* Not encoded JSON. */
				}
			} else {
				const parsed = materialized(nested);
				if (parsed) return parsed;
			}
		}
		const content = candidate.content;
		if (Array.isArray(content))
			for (const part of content) {
				const parsed = materialized(part);
				if (parsed) return parsed;
			}
		return null;
	}
	function layout(value: unknown): WindowLayout | null {
		const candidate = record(value);
		if (!candidate) return null;
		const direct = record(candidate?.layout) ?? candidate;
		if (Array.isArray(direct?.ops))
			return {
				ops: direct.ops
					.filter((op) => record(op))
					.map((op) => op as WindowLayout["ops"][number]),
			};
		for (const key of ["result", "output", "data"]) {
			const nested = layout(candidate?.[key]);
			if (nested) return nested;
		}
		return null;
	}
	function applyToolResults(results: unknown[]) {
		const nextPanels = results
			.map(materialized)
			.filter((panel): panel is MaterializedPanel => panel !== null);
		if (nextPanels.length) panels = nextPanels;
		for (const result of results) windowLayout = layout(result) ?? windowLayout;
	}
	function statValue(panel: MaterializedPanel): Scalar {
		const row = panel.result?.rows[0] ?? [];
		return (
			row.toReversed().find((cell) => typeof cell === "number") ??
			row.toReversed().find((cell) => cell !== null) ??
			"—"
		);
	}
	function proofLabel(panel: MaterializedPanel): string {
		if (panel.panel.type === "refusal") return "refused";
		const bindings = panel.render.bindings ?? [];
		if (bindings.some(({ status }) => status === "refused"))
			return "partly refused";
		if (bindings.length) return `${bindings.length} proved bindings`;
		return panel.result ? `${panel.result.row_count} rows` : "proved surface";
	}
	function panelSpan(panel: MaterializedPanel, index: number): number {
		const arranged = windowLayout?.ops.findLast(
			(op) => op.panel_index === index && (op.verb === "size" || op.verb === "place"),
		)?.layout?.span;
		const span =
			typeof arranged === "number" ? arranged : panel.panel.layout?.span;
		return Math.max(
			3,
			Math.min(
				12,
				typeof span === "number" ? span : panel.panel.type === "stat" ? 4 : 6,
			),
		);
	}
	function panelStyle(panel: MaterializedPanel, index: number): string {
		const placed = windowLayout?.ops.findLast(
			(op) => op.panel_index === index && op.verb === "place",
		)?.layout;
		const col = typeof placed?.col === "number" ? Math.max(0, Math.min(11, placed.col)) + 1 : null;
		const row = typeof placed?.row === "number" ? Math.max(0, placed.row) + 1 : null;
		return `grid-column:${col ? `${col} / span ` : "span "}${panelSpan(panel, index)};${row ? `grid-row-start:${row};` : ""}`;
	}
	function panelHighlighted(panel: MaterializedPanel, index: number): boolean {
		return panel.panel.layout?.highlight === true || windowLayout?.ops.some(
			(op) => op.panel_index === index && op.verb === "highlight",
		) === true;
	}
	function points(panel: MaterializedPanel): string {
		const values = (panel.result?.rows ?? []).map((row) =>
			row
				.toReversed()
				.find((cell): cell is number => typeof cell === "number"),
		);
		const numeric = values.filter(
			(value): value is number => value !== undefined,
		);
		if (numeric.length < 2) return "";
		const min = Math.min(...numeric),
			range = Math.max(1, Math.max(...numeric) - min);
		return numeric
			.map(
				(value, index) =>
					`${8 + (index * 464) / (numeric.length - 1)},${88 - ((value - min) * 72) / range}`,
			)
			.join(" ");
	}

	function payloadFor(target: HTMLElement): AssistantContextPayload {
		const contributor =
			target.closest<HTMLElement>(
				"[data-ask], [data-query-ref], [data-entity-ref]",
			) ?? target;
		const raw =
			contributor.dataset.ask ??
			contributor.getAttribute("aria-label") ??
			contributor.textContent ??
			contributor.tagName;
		const value =
			raw.replace(/\s+/g, " ").trim().slice(0, 500) ||
			contributor.tagName.toLowerCase();
		return {
			element_kind:
				contributor.dataset.askKind ??
				contributor.getAttribute("role") ??
				contributor.tagName.toLowerCase(),
			value,
			...(contributor.dataset.askField
				? { field: contributor.dataset.askField }
				: {}),
			...(contributor.dataset.queryRef
				? { query_ref: contributor.dataset.queryRef }
				: {}),
			...(contributor.dataset.entityRef
				? { entity_ref: contributor.dataset.entityRef }
				: {}),
		};
	}

	function openContextMenu(event: MouseEvent) {
		if (window.getSelection()?.toString()) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (!target || target.closest("input, textarea, [contenteditable=true]"))
			return;
		event.preventDefault();
		menu = {
			x: Math.min(event.clientX, window.innerWidth - 176),
			y: Math.min(event.clientY, window.innerHeight - 104),
			target,
		};
		queueMicrotask(() =>
			menuEl?.querySelector<HTMLButtonElement>("button")?.focus(),
		);
	}

	function openKeyboardMenu(event: KeyboardEvent) {
		const target = event.target instanceof HTMLElement ? event.target : null;
		const typing =
			!!target &&
			(target.matches("input, textarea, [contenteditable=true]") ||
				!!target.closest("input, textarea, [contenteditable=true]"));
		if (event.key === "/" && !typing) {
			event.preventDefault();
			askRef?.focus();
			return;
		}
		if (event.key === "Escape") {
			menu = null;
			return;
		}
		if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
			return;
		if (!target) return;
		event.preventDefault();
		const box = target.getBoundingClientRect();
		menu = {
			x: Math.min(box.left, window.innerWidth - 176),
			y: Math.min(box.bottom, window.innerHeight - 104),
			target,
		};
		queueMicrotask(() =>
			menuEl?.querySelector<HTMLButtonElement>("button")?.focus(),
		);
	}

	async function askAbout(target: HTMLElement) {
		const payload = payloadFor(target);
		context = { label: payload.value.slice(0, 64) };
		menu = null;
		queueMicrotask(() => askRef?.focus());
		if (assistantDown) return;
		contextDelivery = (async () => {
			try {
				await sendAssistantContext(payload);
			} catch {
				assistantFailed = true;
			}
		})();
		await contextDelivery;
		contextDelivery = null;
	}

	async function copyValue(target: HTMLElement) {
		try {
			await navigator.clipboard.writeText(payloadFor(target).value);
		} catch {
			/* Clipboard permission failure leaves the value unchanged and the menu closes. */
		}
		menu = null;
	}

	function runContextAction(target: HTMLElement) {
		const contributor = target.closest<HTMLElement>("[data-context-action]");
		menu = null;
		contributor?.dispatchEvent(new Event("contextaction"));
	}

	async function onAsk(question: string) {
		progress = "Janet is working.";
		try {
			await contextDelivery;
			if (assistantFailed) return;
			const reply = await sendAssistantMessage(question);
			transcript = reply.content;
			applyToolResults(reply.tool_results);
			assistantFailed = false;
		} catch {
			assistantFailed = true;
			transcript = null;
		} finally {
			progress = null;
		}
	}

	function clearContext() {
		context = null;
	}

	onMount(() => {
		if (!assistantDown) {
			sessionRestoring = true;
			void getAssistantSession()
				.then(({ session }) => {
					if (!session) return null;
					windowLayout = layout(session.window_layout);
					if (session.last_context?.value)
						context = {
							label: String(session.last_context.value).slice(0, 64),
						};
					return session;
				})
				.catch(() => {
					/* A missing prior session is an empty state, not an assistant outage. */
					return null;
				})
				.finally(() => (sessionRestoring = false));
		}
		function commandKey(event: KeyboardEvent) {
			if (
				!(event.metaKey || event.ctrlKey) ||
				event.key.toLocaleLowerCase() !== "k"
			)
				return;
			event.preventDefault();
			paletteOpen = true;
		}
		window.addEventListener("keydown", commandKey, { capture: true });
		return () =>
			window.removeEventListener("keydown", commandKey, { capture: true });
	});
</script>

<svelte:window onkeydown={openKeyboardMenu} onclick={() => (menu = null)} />

<div class="shell">
	<Sidebar
		{me}
		{verdict}
		{stateFact}
		{badges}
		onpalette={() => (paletteOpen = true)}
	/>
	<main class="canvas" oncontextmenu={openContextMenu}>
		<div class="surface">
			{#if panels.length}
				<section
					class="assistant-window"
					aria-label="Assistant-composed window"
					aria-live="polite"
				>
					<header>
						<div>
							<h1>Assistant window</h1>
							<p>
								{panels.length} proved {panels.length === 1
									? "panel"
									: "panels"} · caller-scoped
							</p>
						</div>
						<button type="button" onclick={() => (panels = [])}
							><Icon name="x" size={16} />Close window</button
						>
					</header>
					<div class="assistant-grid">
						{#each panels as item, index}
							<article
								class:highlight={panelHighlighted(item, index)}
								style={panelStyle(item, index)}
								data-ask={item.panel.title}
								data-query-ref={item.panel.query_ref ?? undefined}
							>
								<div class="panel-head">
									<div>
										<h2>{item.panel.title}</h2>
										{#if item.panel.description}<p>
												{item.panel.description}
											</p>{/if}
									</div>
									<span>{item.panel.type}</span>
								</div>
								{#if item.panel.type === "refusal"}
									<div class="refusal" role="status">
										<Icon name="circle-help" size={18} />
										<div>
											<b>Couldn’t prove this panel</b>
											<p>
												{item.panel.refusal?.reason ??
													"The requested evidence is unavailable."}
											</p>
											{#each item.panel.refusal?.suggestions ?? [] as suggestion}<button
													type="button"
													onclick={() => {
														context = { label: suggestion };
														queueMicrotask(() => askRef?.focus());
													}}>{suggestion}</button
												>{/each}
										</div>
									</div>
								{:else if item.panel.type === "text" || item.panel.type === "insight"}
									<p class="panel-prose">
										{item.panel.prose ?? "No proved prose was returned."}
									</p>
								{:else if item.panel.type === "stat"}
									<div class="panel-stat">{statValue(item)}</div>
								{:else if item.panel.type === "line" || item.panel.type === "bar"}
									{#if points(item)}<svg
											class="assistant-chart"
											viewBox="0 0 480 96"
											preserveAspectRatio="none"
											role="img"
											aria-label={`${item.panel.title}, ${item.panel.type} chart`}
											><line x1="0" y1="88" x2="480" y2="88" /><polyline
												points={points(item)}
											/></svg
										>{:else}<p class="panel-empty">
											No numeric series was returned.
										</p>{/if}
								{:else if item.result?.rows.length}
									<div class="table-scroll">
										<table>
											<thead
												><tr
													>{#each item.result.columns as column}<th
															>{column.name}</th
														>{/each}</tr
												></thead
											><tbody
												>{#each item.result.rows.slice(0, 20) as row}<tr
														>{#each row as cell}<td>{cell ?? "—"}</td
															>{/each}</tr
													>{/each}</tbody
											>
										</table>
									</div>
								{:else}<p class="panel-empty">
										The query returned no visible rows.
									</p>{/if}
								<footer>
									<Icon name="receipt-text" size={13} /><span
										>{item.render.data_query_ref ??
											item.panel.query_ref ??
											item.render.selection_reason}</span
									><span>{proofLabel(item)}</span>
								</footer>
							</article>
						{/each}
					</div>
				</section>
			{:else if sessionRestoring}<div
					class="window-restoring"
					aria-live="polite"
				>
					Restoring your assistant window…
				</div>{/if}
			{#if !panels.length}{@render children()}{/if}
		</div>
		<AskDock
			bind:this={askRef}
			mode="docked"
			{context}
			{progress}
			{transcript}
			{assistantDown}
			onask={onAsk}
			onclearcontext={clearContext}
		/>
	</main>
</div>
<CommandPalette
	bind:open={paletteOpen}
	lanes={me.lanes}
	{connected}
	onask={() => askRef?.focus()}
/>
{#if menu}
	<div
		bind:this={menuEl}
		class="context-menu"
		style:left={`${menu.x}px`}
		style:top={`${menu.y}px`}
		role="menu"
		aria-label="Element actions"
		tabindex="-1"
	>
		<button type="button" role="menuitem" onclick={() => askAbout(menu!.target)}
			><Icon name="sparkles" size={16} />Ask about this</button
		>
		{#if menu.target.closest("[data-context-action]")}<button
				type="button"
				role="menuitem"
				onclick={() => runContextAction(menu!.target)}
				><Icon name="columns-2" size={16} />{menu.target.closest<HTMLElement>(
					"[data-context-action]",
				)?.dataset.contextAction}</button
			>{/if}
		<button
			type="button"
			role="menuitem"
			onclick={() => copyValue(menu!.target)}
			><Icon name="copy" size={16} />Copy value</button
		>
	</div>
{/if}
<Snackbar />

<style>
	.shell {
		display: grid;
		grid-template-columns: 232px 1fr;
		min-height: 100dvh;
		background: var(--bg);
	}
	.canvas {
		padding: var(--s-4) var(--s-4) var(--s-5);
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.surface {
		min-width: 0;
		padding-bottom: 56px;
	}
	.assistant-window {
		margin-bottom: var(--s-4);
		padding: var(--s-3);
		background: var(--s1);
		border-radius: 12px;
	}
	.assistant-window > header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
		padding-bottom: var(--s-3);
		border-bottom: 1px solid var(--rule);
	}
	.assistant-window h1 {
		font: 400 1.25rem var(--sign);
	}
	.assistant-window header p {
		font: 400 0.6875rem var(--mono);
		color: var(--text-3);
		margin-top: var(--s-1);
	}
	.assistant-window header button {
		min-height: 40px;
		border: 0;
		border-radius: var(--r-sm);
		background: var(--s2);
		color: var(--text-2);
		padding: 0 var(--s-3);
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font: 500 0.75rem var(--sans);
	}
	.assistant-grid {
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: var(--s-3);
		padding-top: var(--s-3);
	}
	.assistant-grid article {
		min-width: 0;
		min-height: 176px;
		padding: var(--s-3);
		background: var(--s2);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
	}
	.assistant-grid article.highlight {
		box-shadow: inset 0 0 0 2px var(--jade);
	}
	.panel-head {
		display: flex;
		justify-content: space-between;
		gap: var(--s-2);
	}
	.panel-head h2 {
		font: 500 0.875rem var(--sans);
		text-wrap: balance;
	}
	.panel-head p {
		font-size: 0.75rem;
		color: var(--text-3);
		margin-top: var(--s-1);
	}
	.panel-head > span {
		font: 500 0.6875rem var(--mono);
		color: var(--jade-text);
	}
	.panel-prose {
		max-width: 70ch;
		margin: auto 0;
		font-size: 0.8125rem;
		white-space: pre-wrap;
		text-wrap: pretty;
	}
	.panel-stat {
		margin: auto 0;
		font: 500 1.75rem var(--mono);
		color: var(--text);
	}
	.assistant-chart {
		width: 100%;
		height: 96px;
		margin: auto 0;
	}
	.assistant-chart line {
		stroke: var(--rule-strong);
		stroke-width: 1;
	}
	.assistant-chart polyline {
		fill: none;
		stroke: var(--petal);
		stroke-width: 2;
		stroke-linejoin: round;
	}
	.table-scroll {
		overflow: auto;
		margin: var(--s-2) 0;
	}
	.assistant-grid table {
		width: 100%;
		border-collapse: collapse;
		font: 400 0.75rem var(--mono);
	}
	.assistant-grid th,
	.assistant-grid td {
		text-align: left;
		padding: var(--s-1) var(--s-2);
		border-bottom: 1px solid var(--rule);
		white-space: nowrap;
	}
	.assistant-grid th {
		color: var(--text-3);
		font-weight: 500;
	}
	.assistant-grid article footer {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-top: auto;
		padding-top: var(--s-2);
		border-top: 1px solid var(--rule);
		font: 400 0.6875rem var(--mono);
		color: var(--text-3);
	}
	.assistant-grid article footer span:last-child {
		margin-inline-start: auto;
	}
	.refusal {
		display: flex;
		gap: var(--s-2);
		margin: auto 0;
		padding: var(--s-2);
		background: var(--warn-soft);
		color: var(--warn-text);
		border-radius: var(--r-xs);
	}
	.refusal b {
		font-size: 0.8125rem;
	}
	.refusal p,
	.panel-empty {
		font-size: 0.75rem;
		margin-top: var(--s-1);
		color: var(--text-2);
	}
	.refusal button {
		display: block;
		min-height: 32px;
		border: 0;
		background: transparent;
		color: var(--petal-text);
		font: 500 0.75rem var(--sans);
		text-align: left;
		padding: var(--s-1) 0;
	}
	.window-restoring {
		min-height: 40px;
		color: var(--text-3);
		font: 400 0.75rem var(--mono);
	}
	.context-menu {
		position: fixed;
		z-index: var(--z-dropdown);
		width: 168px;
		padding: var(--s-1);
		background: var(--s1);
		box-shadow: 0 2px 8px color-mix(in srgb, var(--text) 14%, transparent);
		border-radius: var(--r-sm);
	}
	.context-menu button {
		width: 100%;
		min-height: 40px;
		padding: 0 var(--s-2);
		border: 0;
		background: transparent;
		color: var(--text);
		border-radius: var(--r-sm);
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font: 500 0.75rem var(--sans);
		text-align: left;
	}
	.context-menu button:hover {
		background: var(--s2);
	}
	.context-menu button:focus-visible {
		outline: 2px solid var(--petal);
		outline-offset: 2px;
	}
	@media (max-width: 1279px) {
		.shell {
			grid-template-columns: 56px 1fr;
		}
	}
	@media (max-width: 767px) {
		.canvas {
			padding: var(--s-3) var(--s-3) var(--s-5);
		}
		.assistant-grid article {
			grid-column: span 12 !important;
		}
		.assistant-window {
			padding: var(--s-2);
		}
		.assistant-window > header {
			align-items: flex-start;
		}
		.assistant-window header button {
			font-size: 0;
			padding: 0 var(--s-2);
		}
	}
</style>
