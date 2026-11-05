<script lang="ts">
	import { goto } from "$app/navigation";
	import { resolve } from "$app/paths";
	import { placeholders, type TemplateCategory, type TemplateField } from "$lib/doc";
	import Banner from "$lib/ui/Banner.svelte";
	import Button from "$lib/ui/Button.svelte";
	import { CATEGORIES } from "$lib/ui/categories";
	import { api, errorText } from "$lib/ui/client";
	import Select from "$lib/ui/Select.svelte";
	import Sheet from "$lib/ui/Sheet.svelte";

	import { editor } from "./editor.svelte";

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let name = $state("");
	let category = $state<TemplateCategory>("home");
	let description = $state("");
	let fields = $state<TemplateField[]>([]);
	let saving = $state(false);
	let failure = $state<string | null>(null);

	const updatable = $derived(editor.template !== null && !editor.template.builtin);

	// Each open starts from the document: its variables become fields, keeping known labels.
	$effect(() => {
		if (!open) {
			return;
		}

		failure = null;
		const known = new Map((editor.template?.fields ?? []).map((field) => [field.key, field]));

		fields = placeholders(editor.doc).map(
			(key) =>
				known.get(key) ?? {
					key,
					label: key.charAt(0).toUpperCase() + key.slice(1).replaceAll(/[_-]/g, " "),
					kind: "text",
					default: editor.vars[key] ?? "",
				},
		);

		name = editor.template && !editor.template.builtin ? editor.template.name : "";
	});

	async function save(asNew: boolean): Promise<void> {
		saving = true;
		failure = null;

		const input = {
			name: name.trim(),
			category,
			description: description.trim(),
			doc: $state.snapshot(editor.doc),
			fields: $state.snapshot(fields),
		};

		try {
			const template =
				!asNew && updatable && editor.template
					? await api.updateTemplate(editor.template.id, input)
					: await api.createTemplate(input);

			editor.setTemplate({
				id: template.id,
				name: template.name,
				builtin: false,
				fields: template.fields,
			});

			open = false;
			await goto(resolve("/templates"));
		} catch (error) {
			failure = errorText(error, "Saving failed");
		} finally {
			saving = false;
		}
	}
</script>

<Sheet bind:open title={updatable ? "Save template" : "Save as template"} width="520px">
	<form
		class="form"
		onsubmit={(event) => {
			event.preventDefault();
		}}
	>
		<label class="field">
			<span>Name</span>
			<!-- svelte-ignore a11y_autofocus -->
			<input bind:value={name} placeholder="Pantry jar" autocomplete="off" required autofocus />
		</label>
		<label class="field" for="template-category">
			<span>Category</span>
			<Select
				id="template-category"
				value={category}
				options={CATEGORIES.map((item) => ({ value: item.id, label: item.name }))}
				onchange={(value: typeof category) => (category = value)}
			/>
		</label>
		<label class="field">
			<span>Description</span>
			<input bind:value={description} placeholder="What it is for" autocomplete="off" />
		</label>

		<h3>Fields</h3>
		{#if fields.length === 0}
			<p class="hint">
				This label has no fields. Put {"{{name}}"} in a text or code element to make a blank people fill
				in.
			</p>
		{:else}
			<div class="fields">
				<span class="col">Variable</span>
				<span class="col">Label</span>
				<span class="col">Default</span>
				{#each fields as field, index (field.key)}
					<code>{field.key}</code>
					<input aria-label="Label for {field.key}" bind:value={fields[index].label} />
					<input aria-label="Default for {field.key}" bind:value={fields[index].default} />
				{/each}
			</div>
		{/if}
		{#if failure}<Banner tone="danger">{failure}</Banner>{/if}
	</form>

	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
		{#if updatable}
			<Button disabled={name.trim() === ""} busy={saving} onclick={() => save(true)}
				>Save as new</Button
			>
		{/if}
		<Button
			variant="primary"
			disabled={name.trim() === ""}
			busy={saving}
			onclick={() => save(false)}
		>
			{updatable ? "Update template" : "Save template"}
		</Button>
	{/snippet}
</Sheet>

<style>
	.form {
		display: grid;
		gap: 12px;
	}

	.field {
		display: grid;
		gap: 4px;
	}

	.field > span,
	.col {
		color: var(--ink-2);
		font-size: 12px;
		font-weight: 500;
	}

	input {
		width: 100%;
		min-width: 0;
		height: 36px;
		padding-inline: 10px;
		border: 0;
		border-radius: var(--r);
		background: var(--sunken);
	}

	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}

	h3 {
		margin-top: 8px;
		font-size: 14px;
		font-weight: 600;
	}

	.fields {
		display: grid;
		grid-template-columns: minmax(64px, auto) 1fr 1fr;
		align-items: center;
		gap: 6px 8px;
	}

	code {
		overflow: hidden;
		color: var(--ink-2);
		font-size: 12px;
		text-overflow: ellipsis;
	}

	.hint {
		color: var(--ink-3);
		font-size: 12px;
	}
</style>
