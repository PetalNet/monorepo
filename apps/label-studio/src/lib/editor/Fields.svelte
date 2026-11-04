<script lang="ts">
	import { placeholders } from "$lib/doc";
	import { LayoutGrid } from "@lucide/svelte";

	import { editor } from "./editor.svelte";

	/** Fill-in-the-blanks for the template's variables, named by the template they came from. */
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

<div class="template-bar">
	{#if editor.template}
		<p class="template-name" title={editor.template.name}>
			<LayoutGrid size={14} aria-hidden="true" />
			<span>{editor.template.name}</span>
		</p>
	{/if}
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
</div>

<style>
	.template-bar {
		display: flex;
		align-items: center;
		gap: 8px 12px;
		margin: 0 12px;
		padding: 8px;
		border-radius: var(--r);
		background: var(--sunken);
		animation: enter var(--base) var(--ease);
	}

	.template-name {
		display: flex;
		flex: none;
		align-items: center;
		gap: 6px;
		max-width: 180px;
		padding-inline-start: 4px;
		color: var(--ink-2);
		font-size: 13px;
		font-weight: 500;
	}

	.template-name span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}

	/* Each field is one control with its label inside: a single row above the canvas on a desktop, a
	   grouped list under the canvas on a phone. */
	.fields {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		gap: 8px;
		min-width: 0;
	}

	.field {
		display: flex;
		flex: 1 1 200px;
		align-items: center;
		min-width: 0;
		height: 32px;
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
		cursor: text;
		transition: box-shadow var(--fast) var(--ease-standard);
	}

	.field:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}

	.wide {
		flex-basis: 100%;
		height: auto;
		align-items: flex-start;
	}

	.field span {
		flex: none;
		max-width: 45%;
		padding-inline: 10px 8px;
		overflow: hidden;
		color: var(--ink-3);
		font-size: 12px;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.wide span {
		padding-block: 8px;
	}

	input,
	textarea {
		flex: 1;
		width: 100%;
		min-width: 0;
		height: 100%;
		padding-inline: 0 10px;
		border: 0;
		background: transparent;
		outline: none;
	}

	textarea {
		height: auto;
		padding-block: 7px;
		resize: vertical;
	}

	@media (max-width: 760px) {
		.template-bar {
			flex-direction: column;
			align-items: stretch;
			gap: 8px;
			margin: 0 12px 16px;
			padding: 0;
			background: none;
		}

		.template-name {
			max-width: none;
			padding-inline-start: 2px;
		}

		.fields {
			flex-direction: column;
			gap: 0;
			border-radius: var(--r);
			background: var(--panel);
			box-shadow: var(--shadow-panel);
			overflow: hidden;
		}

		.field {
			flex: none;
			height: 48px;
			border-radius: 0;
			background: transparent;
			box-shadow: none;
		}

		.field + .field {
			box-shadow: 0 -1px 0 var(--rule);
		}

		.field:focus-within {
			outline-offset: -2px;
		}

		.wide {
			height: auto;
		}

		.field span {
			width: 38%;
			padding-inline: 14px 8px;
			color: var(--ink-2);
			font-size: 14px;
		}

		.wide span {
			padding-block: 14px;
		}

		input,
		textarea {
			padding-inline-end: 14px;
			font-size: 16px;
		}

		textarea {
			padding-block: 12px;
		}
	}
</style>
