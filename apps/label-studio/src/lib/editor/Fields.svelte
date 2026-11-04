<script lang="ts">
	import { placeholders } from "$lib/doc";

	import { editor } from "./editor.svelte";

	/** Fill-in-the-blanks for the template's variables, above the canvas. */
	const fields = $derived.by(() => {
		const declared = editor.template?.fields ?? [];
		const known = new Set(declared.map((field) => field.key));
		const extra = placeholders(editor.doc)
			.filter((key) => !known.has(key))
			.map((key) => ({
				key,
				label: key,
				kind: "text" as const,
				default: "",
				placeholder: undefined,
			}));

		return [...declared, ...extra];
	});

	const inputType = {
		text: "text",
		multiline: "text",
		date: "date",
		number: "number",
		url: "url",
	} as const;
</script>

{#if fields.length > 0}
	<form
		class="fields"
		onsubmit={(event) => {
			event.preventDefault();
		}}
		aria-label="Label fields"
	>
		{#each fields as field (field.key)}
			<label class="field" class:wide={field.kind === "multiline"}>
				<span>{field.label}</span>
				{#if field.kind === "multiline"}
					<textarea
						rows="2"
						value={editor.vars[field.key] ?? field.default}
						placeholder={field.placeholder ?? field.default}
						oninput={(event) => {
							editor.vars[field.key] = event.currentTarget.value;
						}}></textarea>
				{:else}
					<input
						type={inputType[field.kind]}
						value={editor.vars[field.key] ?? field.default}
						placeholder={field.placeholder ?? field.default}
						autocomplete="off"
						oninput={(event) => {
							editor.vars[field.key] = event.currentTarget.value;
						}}
					/>
				{/if}
			</label>
		{/each}
	</form>
{/if}

<style>
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 8px 12px;
	}

	.field {
		display: grid;
		gap: 4px;
	}

	.wide {
		grid-column: 1 / -1;
	}

	.field span {
		color: var(--ink-2);
		font-size: 12px;
		font-weight: 500;
	}

	input,
	textarea {
		width: 100%;
		min-width: 0;
		height: 36px;
		padding-inline: 10px;
		border: 0;
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
	}

	textarea {
		height: auto;
		padding-block: 8px;
		resize: vertical;
	}

	input:focus-visible,
	textarea:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}

	@media (pointer: coarse) {
		input {
			height: 44px;
		}
	}
</style>
