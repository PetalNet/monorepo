<script lang="ts">
	import type { SourceId, SourceInfo } from "$lib/api";
	import { dotsToMm, placeholders, type LabelDoc, type Vars } from "$lib/doc";
	import { applyMap, autoMap, parseTable, type ColumnMap, type Table } from "$lib/editor/batch";
	import { editor } from "$lib/editor/editor.svelte";
	import { resolveVars } from "$lib/editor/persist";
	import Banner from "$lib/ui/Banner.svelte";
	import Button from "$lib/ui/Button.svelte";
	import { chrome } from "$lib/ui/chrome.svelte";
	import { api, errorText } from "$lib/ui/client";
	import PrintSheet from "$lib/ui/PrintSheet.svelte";
	import Row from "$lib/ui/Row.svelte";
	import Segmented from "$lib/ui/Segmented.svelte";
	import Select from "$lib/ui/Select.svelte";
	import Skeleton from "$lib/ui/Skeleton.svelte";
	import Switch from "$lib/ui/Switch.svelte";
	import TapeLabel from "$lib/ui/TapeLabel.svelte";
	import { templates } from "$lib/ui/templates.svelte";
	import { formatMm, relativeTime } from "$lib/ui/words";
	import { CircleCheck, FileUp, Printer, Server } from "@lucide/svelte";
	import { SvelteSet } from "svelte/reactivity";

	type Input = "paste" | "file" | "source";

	const PASTE_HINT = "One label per line\nor CSV: name,location\nFlour,Pantry";

	let designId = $state<string>("editor");
	let input = $state<Input>("paste");
	let text = $state("");
	let header = $state(false);
	let fileName = $state<string | null>(null);
	let fileError = $state<string | null>(null);
	let sources = $state<SourceInfo[] | null>(null);
	let sourcesError = $state<string | null>(null);
	let source = $state<{
		id: SourceId;
		loading: boolean;
		table: Table | null;
		error: string | null;
		fetchedAt?: string;
	} | null>(null);
	const excluded = new SvelteSet<number>();
	let lengths = $state<Partial<Record<number, number>>>({});
	let printing = $state(false);

	void templates.ensure();

	const design = $derived.by((): { doc: LabelDoc; name: string; vars: Vars } => {
		const template = templates.list.find((candidate) => candidate.id === designId);

		if (template) {
			return { doc: template.doc, name: template.name, vars: resolveVars(template.fields, {}) };
		}

		return {
			doc: editor.doc,
			name: editor.template?.name ?? "Editor label",
			vars: editor.resolvedVars,
		};
	});
	const keys = $derived(placeholders(design.doc));
	const fieldLabels = $derived.by((): Partial<Record<string, string>> => {
		const template = templates.list.find((candidate) => candidate.id === designId);
		const fields = template?.fields ?? editor.template?.fields ?? [];

		return Object.fromEntries(fields.map((field) => [field.key, field.label]));
	});
	const table = $derived.by((): Table => {
		if (input === "source") {
			return source?.table ?? { columns: [], rows: [] };
		}

		return parseTable(text, header);
	});
	// Columns re-match whenever the columns or the template's variables change; the user can override.
	let map = $derived<ColumnMap>(autoMap(table.columns, keys));
	const rows = $derived(applyMap(table, map));
	const chosen = $derived(
		rows.flatMap((row, index) => (excluded.has(index) ? [] : [{ row, index }])),
	);
	const totalMm = $derived(
		chosen.reduce((sum, { index }) => sum + dotsToMm(lengths[index] ?? 0), 0),
	);
	const measured = $derived(chosen.every(({ index }) => lengths[index] !== undefined));

	$effect(() => {
		void table;
		void design;
		excluded.clear();
		lengths = {};
	});

	$effect(() => {
		if (input === "source" && sources === null) {
			api.sources().then(
				(list) => {
					sources = list;
				},
				(error: unknown) => {
					sourcesError = errorText(error, "Sources failed to load");
				},
			);
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

	async function readFile(file: File): Promise<void> {
		fileError = null;

		try {
			text = await file.text();
			fileName = file.name;
			header = true;
		} catch {
			fileError = "That file could not be read.";
		}
	}

	async function pull(id: SourceId): Promise<void> {
		source = { id, loading: true, table: null, error: null };

		try {
			const result = await api.sourceRows(id);

			source = {
				id,
				loading: false,
				table: { columns: result.columns, rows: result.rows },
				error: null,
				fetchedAt: result.fetchedAt,
			};
		} catch (error) {
			source = { id, loading: false, table: null, error: errorText(error, "The source failed") };
		}
	}

	function toggle(index: number): void {
		if (excluded.has(index)) {
			excluded.delete(index);
		} else {
			excluded.add(index);
		}
	}

	const designs = $derived([
		{ value: "editor", label: `Editor: ${editor.template?.name ?? "current label"}` },
		...templates.list
			.filter((template) => template.fields.length > 0)
			.map((template) => ({ value: template.id, label: template.name })),
	]);
</script>

{#snippet printAction()}
	<Button
		variant="primary"
		disabled={chosen.length === 0 || !measured}
		onclick={() => (printing = true)}
	>
		<Printer size={16} />
		<span>Print {chosen.length || ""}</span>
		{#if chosen.length > 0 && measured}<span class="length num">{formatMm(totalMm)} mm</span>{/if}
	</Button>
{/snippet}

<div class="page">
	<header>
		<h1>Batch</h1>
		<p class="sub">One label per row, printed as one job.</p>
	</header>

	<div class="layout">
		<div class="setup">
			<section class="card">
				<h2>Design</h2>
				<Row label="Template" for="batch-design">
					<Select
						id="batch-design"
						value={designId}
						options={designs}
						onchange={(value: typeof designId) => (designId = value)}
					/>
				</Row>
				{#if keys.length === 0}
					<Banner tone="warn">
						This label has no fields to fill. Pick a template with fields, or put {"{{text}}"} in a text
						element.
					</Banner>
				{/if}
			</section>

			<section class="card">
				<h2>Rows</h2>
				<Segmented
					label="Row source"
					options={[
						{ value: "paste", label: "Paste" },
						{ value: "file", label: "CSV file" },
						{ value: "source", label: "Lab source" },
					]}
					value={input}
					onchange={(next: Input) => {
						input = next;
					}}
				/>
				{#if input === "paste"}
					<textarea
						bind:value={text}
						rows="7"
						placeholder={PASTE_HINT}
						aria-label="Rows"
						spellcheck="false"></textarea>
					<Row label="Header" for="batch-header">
						<Switch
							id="batch-header"
							label="First row names the columns"
							checked={header}
							onchange={(value: boolean) => (header = value)}
						/>
						<span class="hint">First row names the columns</span>
					</Row>
				{:else if input === "file"}
					<label class="drop">
						<FileUp aria-hidden="true" />
						<span>{fileName ?? "Choose a CSV file"}</span>
						<input
							class="sr-only"
							type="file"
							accept=".csv,.tsv,.txt,text/csv,text/plain"
							onchange={(event) => {
								const file = event.currentTarget.files?.[0];

								if (file) {
									void readFile(file);
								}
							}}
						/>
					</label>
					{#if fileError}<Banner tone="danger">{fileError}</Banner>{/if}
					<Row label="Header" for="batch-file-header">
						<Switch
							id="batch-file-header"
							label="First row names the columns"
							checked={header}
							onchange={(value: boolean) => (header = value)}
						/>
						<span class="hint">First row names the columns</span>
					</Row>
				{:else}
					{#if sourcesError}
						<Banner tone="danger">{sourcesError}</Banner>
					{:else if sources === null}
						<Skeleton height="44px" /><Skeleton height="44px" />
					{:else if sources.length === 0}
						<p class="hint">No lab sources are available on this server.</p>
					{:else}
						<ul class="sources">
							{#each sources as item (item.id)}
								<li>
									<button
										type="button"
										class="source"
										class:active={source?.id === item.id}
										disabled={!item.configured}
										onclick={() => pull(item.id)}
									>
										<Server aria-hidden="true" />
										<span class="source-name">{item.label}</span>
										<span class="source-state">
											{#if !item.configured}
												Not configured
											{:else if source?.id === item.id && source.loading}
												Loading
											{:else if source?.id === item.id && source.table}
												<CircleCheck size={14} aria-hidden="true" /> {source.table.rows.length} rows
											{:else}
												Load rows
											{/if}
										</span>
									</button>
								</li>
							{/each}
						</ul>
						{#if sources.some((item) => !item.configured)}
							<p class="hint">
								Unconfigured sources need their LABEL_STUDIO_ settings in the server environment.
								See the README.
							</p>
						{/if}
						{#if source?.error}<Banner tone="danger">{source.error}</Banner>{/if}
						{#if source?.fetchedAt}<p class="hint">Fetched {relativeTime(source.fetchedAt)}</p>{/if}
					{/if}
				{/if}
			</section>

			{#if keys.length > 0 && table.columns.length > 0}
				<section class="card">
					<h2>Columns</h2>
					{#each keys as key (key)}
						<Row label={fieldLabels[key] ?? key} for="map-{key}">
							<Select
								id="map-{key}"
								value={map[key] ?? ""}
								options={[
									{ value: "", label: "Leave as default" },
									...table.columns.map((column) => ({ value: column.key, label: column.label })),
								]}
								onchange={(value: string) => {
									map = { ...map, [key]: value === "" ? null : value };
								}}
							/>
						</Row>
					{/each}
				</section>
			{/if}
		</div>

		<section class="preview">
			<div class="preview-head">
				<h2 class="num">
					{#if rows.length === 0}
						Preview
					{:else}
						{chosen.length} of {rows.length} labels
						{#if measured && chosen.length > 0}<span class="total"
								>· {formatMm(totalMm)} mm of tape</span
							>{/if}
					{/if}
				</h2>
				{#if rows.length > 0}
					<div class="bulk">
						<Button
							size="sm"
							variant="ghost"
							onclick={() => {
								excluded.clear();
							}}>All</Button
						>
						<Button
							size="sm"
							variant="ghost"
							onclick={() => {
								for (const index of rows.keys()) {
									excluded.add(index);
								}
							}}>None</Button
						>
					</div>
				{/if}
			</div>
			{#if rows.length === 0}
				<div class="empty">
					<p>
						Paste lines or a CSV, load a file, or pull rows from a lab source. Every row becomes one
						label here.
					</p>
				</div>
			{:else}
				<ul class="grid">
					{#each rows as row, index (index)}
						<li>
							<label class="cell" class:off={excluded.has(index)}>
								<input
									type="checkbox"
									checked={!excluded.has(index)}
									onchange={() => {
										toggle(index);
									}}
								/>
								<span class="index num">{index + 1}</span>
								<TapeLabel
									doc={design.doc}
									vars={{ ...design.vars, ...row }}
									maxWidth={260}
									maxHeight={56}
									onlength={(dots: number) => {
										if (lengths[index] !== dots) {
											lengths[index] = dots;
										}
									}}
								/>
							</label>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</div>

<PrintSheet
	bind:open={printing}
	doc={design.doc}
	vars={design.vars}
	rows={chosen.map(({ row }) => row)}
	title="{design.name} × {chosen.length}"
	lengthMm={totalMm}
/>

<style>
	.page {
		display: grid;
		gap: 20px;
		max-width: 1440px;
		margin-inline: auto;
		padding: 24px 24px 96px;
	}

	h1 {
		font-size: 22px;
		font-weight: 500;
		line-height: 1.2;
	}

	.sub {
		color: var(--ink-2);
	}

	.layout {
		display: grid;
		grid-template-columns: 360px minmax(0, 1fr);
		align-items: start;
		gap: 20px;
	}

	.setup {
		display: grid;
		gap: 12px;
	}

	.card {
		display: grid;
		gap: 10px;
		padding: 16px;
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
	}

	h2 {
		font-size: 14px;
		font-weight: 600;
	}

	textarea {
		width: 100%;
		padding: 10px;
		border: 0;
		border-radius: var(--r);
		background: var(--sunken);
		resize: vertical;
		font-variant-numeric: tabular-nums;
	}

	textarea:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}

	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}

	.drop {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 64px;
		padding-inline: 16px;
		border-radius: var(--r);
		background: var(--sunken);
		color: var(--ink-2);
		cursor: pointer;
		transition: background-color var(--fast);
	}

	.drop:hover {
		background: color-mix(in oklch, var(--sunken), var(--ink) 5%);
	}

	.drop:focus-within {
		outline: 2px solid var(--accent);
	}

	.sources {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.source {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		height: 44px;
		padding-inline: 12px;
		border: 0;
		border-radius: var(--r);
		background: var(--sunken);
		color: var(--ink);
		cursor: pointer;
	}

	.source:disabled {
		color: var(--ink-3);
		cursor: default;
	}

	.source.active {
		background: var(--accent-soft);
	}

	.source :global(svg) {
		width: 16px;
		height: 16px;
	}

	.source-name {
		flex: 1;
		text-align: start;
	}

	.source-state {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--ink-3);
		font-size: 12px;
	}

	.preview {
		display: grid;
		gap: 12px;
		min-width: 0;
	}

	.preview-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 32px;
	}

	.total {
		color: var(--ink-2);
		font-weight: 400;
	}

	.bulk {
		display: flex;
		gap: 4px;
	}

	.empty {
		display: grid;
		place-items: center;
		min-height: 240px;
		padding: 24px;
		border-radius: var(--r);
		background: var(--sunken);
		color: var(--ink-2);
		text-align: center;
	}

	.empty p {
		max-width: 40ch;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.cell {
		position: relative;
		display: grid;
		grid-template-columns: auto auto 1fr;
		align-items: center;
		gap: 10px;
		min-height: 96px;
		padding: 12px;
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
		--dimension-bg: var(--panel);
		cursor: pointer;
		transition: opacity var(--base);
	}

	.cell.off {
		opacity: 0.45;
	}

	.cell input {
		width: 18px;
		height: 18px;
		accent-color: var(--accent);
	}

	.index {
		color: var(--ink-3);
		font-size: 12px;
	}

	.length {
		padding-inline-start: 8px;
		box-shadow: -1px 0 0 color-mix(in oklch, var(--on-accent) 35%, transparent);
		font-weight: 400;
	}

	@media (max-width: 960px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 760px) {
		.page {
			padding: 16px 16px 96px;
		}

		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
