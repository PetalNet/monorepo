<script lang="ts">
	import { SvelteMap } from "svelte/reactivity";

	import { BUILD_COMMAND, type Evaluate, loadEngine } from "./engine.ts";
	import { type CellId, type CellResult, cellId, COLUMNS, ROWS } from "./sheet.ts";

	const SEED: Record<string, string> = {
		A1: "distance",
		B1: "26.2 mi",
		A2: "time",
		B2: "3 h + 30 min",
		A3: "speed",
		B3: "=B1 / B2 -> mph",
		A4: "pace",
		B4: "=1 / B3 -> min/mi",
		A5: "mismatch",
		B5: "=B1 + B2",
	};

	type Engine =
		| { status: "loading" }
		| { status: "failed"; reason: string }
		| { status: "ready"; evaluate: Evaluate };

	const inputs = new SvelteMap<CellId, string>(Object.entries(SEED) as [CellId, string][]);
	let engine = $state<Engine>({ status: "loading" });
	let editing = $state<CellId>();
	let selected = $state(cellId("A", 1));

	const results = $derived(engine.status === "ready" ? engine.evaluate(inputs) : undefined);
	const current = $derived(results?.get(selected));

	loadEngine().then(
		(evaluate) => (engine = { status: "ready", evaluate }),
		(error: unknown) => (engine = { status: "failed", reason: String(error) }),
	);

	const shown = (result: CellResult | undefined) =>
		result?.kind === "value"
			? result.display
			: result?.kind === "text"
				? result.text
				: result?.kind === "error"
					? result.code
					: "";

	const detail = (result: CellResult | undefined) =>
		result?.kind === "value"
			? result.full
			: result?.kind === "error"
				? `${result.code} ${result.message}`
				: shown(result);

	function focus(id: CellId) {
		editing = id;
		selected = id;
	}

	function commit(id: CellId, input: HTMLInputElement) {
		inputs.set(id, input.value);
		editing = undefined;
	}

	function moveDown(input: HTMLInputElement, column: (typeof COLUMNS)[number], row: number) {
		const below = document.querySelector<HTMLInputElement>(
			`input[data-cell="${cellId(column, row + 1)}"]`,
		);

		if (below) {
			below.focus();
		} else {
			input.blur();
		}
	}
</script>

<main>
	<h1>Numbat sheet</h1>
	<p class="hint">
		Each cell is a <a href="https://numbat.dev">Numbat</a> value like <code>26.2 mi</code>, a
		formula like <code>=B1 / B2 -&gt; mph</code>, or text.
	</p>

	{#if engine.status === "failed"}
		<p class="banner" role="alert">
			The Numbat engine did not load. Build it with <code>{BUILD_COMMAND}</code>, then reload.
			<span class="reason">{engine.reason}</span>
		</p>
	{:else if engine.status === "loading"}
		<p class="banner">Loading the Numbat engine.</p>
	{/if}

	<section class="bar" aria-label="Formula bar">
		<span class="address">{selected}</span>
		<code class="raw">{inputs.get(selected) ?? ""}</code>
		<output class="detail" class:error={current?.kind === "error"}>{detail(current)}</output>
	</section>

	<div class="scroll">
		<table>
			<thead>
				<tr>
					<td></td>
					{#each COLUMNS as column (column)}
						<th scope="col">{column}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each ROWS as row (row)}
					<tr>
						<th scope="row">{row}</th>
						{#each COLUMNS as column (column)}
							{@const id = cellId(column, row)}
							{@const result = results?.get(id)}
							<td>
								<input
									class:error={result?.kind === "error"}
									aria-label={id}
									data-cell={id}
									title={detail(result) || undefined}
									value={editing === id ? (inputs.get(id) ?? "") : shown(result)}
									onfocus={() => {
										focus(id);
									}}
									onblur={(event) => {
										commit(id, event.currentTarget);
									}}
									onkeydown={(event) => {
										if (event.key === "Enter") {
											moveDown(event.currentTarget, column, row);
										}
									}}
								/>
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</main>

<style>
	:global(:root) {
		--surface: #fbfaf7;
		--ink: #1d1b18;
		--muted: #4a4640;
		--rule: #d9d5cc;
		--header: #f0ede6;
		--focus: #1f4f8a;
		--error: #8c1d18;
		--error-surface: #fbeeec;
		color-scheme: light dark;
		font-family: system-ui, sans-serif;
		background: var(--surface);
		color: var(--ink);
	}

	@media (prefers-color-scheme: dark) {
		:global(:root) {
			--surface: #161513;
			--ink: #ece9e2;
			--muted: #c4bfb5;
			--rule: #3a3732;
			--header: #211f1c;
			--focus: #9cc2f0;
			--error: #ffb4ab;
			--error-surface: #3a1714;
		}
	}

	:global(body) {
		margin: 0;
	}

	main {
		max-inline-size: 72rem;
		margin-inline: auto;
		padding: 32px 16px;
	}

	h1 {
		margin-block: 0 8px;
		font-size: 1.5rem;
		font-weight: 500;
	}

	.hint,
	.banner {
		margin-block: 0 16px;
		color: var(--muted);
	}

	.banner[role="alert"] {
		color: var(--error);
	}

	.reason {
		display: block;
		font-size: 0.875rem;
	}

	a {
		color: var(--focus);
	}

	.bar {
		display: grid;
		grid-template-columns: 40px 1fr;
		gap: 8px 16px;
		margin-block-end: 16px;
		padding: 8px;
		background: var(--header);
		border-radius: 2px;
	}

	.address {
		color: var(--muted);
		font-weight: 500;
	}

	.detail {
		grid-column: 2;
		min-block-size: 1lh;
		white-space: pre-wrap;
		font-variant-numeric: tabular-nums;
	}

	.detail.error {
		color: var(--error);
	}

	.scroll {
		overflow-x: auto;
	}

	table {
		inline-size: 100%;
		min-inline-size: 40rem;
		table-layout: fixed;
		border-spacing: 1px;
		background: var(--rule);
		border-radius: 2px;
	}

	thead td {
		inline-size: 40px;
	}

	th,
	thead td {
		padding: 8px;
		background: var(--header);
		color: var(--muted);
		font-size: 0.875rem;
		font-weight: 500;
	}

	td {
		padding: 0;
	}

	input {
		box-sizing: border-box;
		inline-size: 100%;
		padding: 8px;
		font: inherit;
		font-variant-numeric: tabular-nums;
		color: inherit;
		background: var(--surface);
		border: 0;
		border-radius: 0;
		text-overflow: ellipsis;
		transition: background-color 120ms ease-out;
	}

	input:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}

	input.error {
		color: var(--error);
		background: var(--error-surface);
	}
</style>
