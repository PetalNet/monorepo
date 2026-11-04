<script lang="ts">
	import { goto } from "$app/navigation";
	import { resolve } from "$app/paths";
	import type { Template, TemplateCategory } from "$lib/doc";
	import { editor } from "$lib/editor/editor.svelte";
	import { resolveVars, sampleVars } from "$lib/editor/persist";
	import Banner from "$lib/ui/Banner.svelte";
	import Button from "$lib/ui/Button.svelte";
	import { CATEGORIES } from "$lib/ui/categories";
	import { api, errorText } from "$lib/ui/client";
	import IconButton from "$lib/ui/IconButton.svelte";
	import Sheet from "$lib/ui/Sheet.svelte";
	import Skeleton from "$lib/ui/Skeleton.svelte";
	import TapeLabel from "$lib/ui/TapeLabel.svelte";
	import { templates } from "$lib/ui/templates.svelte";
	import { Copy, FilePlusCorner, Search, Trash2 } from "@lucide/svelte";

	let filter = $state<TemplateCategory | "all">("all");
	let query = $state("");
	let deleting = $state<Template | null>(null);
	let confirmDelete = $state(false);
	let busy = $state<string | null>(null);
	let failure = $state<string | null>(null);

	void templates.refresh();

	const matches = $derived(
		templates.list.filter(
			(template) =>
				(filter === "all" || template.category === filter) &&
				`${template.name} ${template.description}`
					.toLowerCase()
					.includes(query.trim().toLowerCase()),
		),
	);
	const groups = $derived(
		CATEGORIES.map((category) => ({
			...category,
			templates: matches.filter((template) => template.category === category.id),
		})).filter((group) => group.templates.length > 0),
	);
	const present = $derived(new Set(templates.list.map((template) => template.category)));

	async function open(template: Template): Promise<void> {
		editor.loadTemplate(template);
		await goto(resolve("/"));
	}

	async function duplicateTemplate(template: Template): Promise<void> {
		busy = template.id;
		failure = null;

		try {
			const copy = await api.createTemplate({
				name: `${template.name} copy`,
				category: template.category,
				description: template.description,
				doc: template.doc,
				fields: template.fields,
			});

			await templates.refresh();
			await open(copy);
		} catch (error) {
			failure = errorText(error, "Could not duplicate the template");
		} finally {
			busy = null;
		}
	}

	async function remove(): Promise<void> {
		if (!deleting) {
			return;
		}

		const target = deleting;

		busy = target.id;
		failure = null;

		try {
			await api.deleteTemplate(target.id);

			if (editor.template?.id === target.id) {
				editor.template = null;
			}

			confirmDelete = false;
			await templates.refresh();
		} catch (error) {
			failure = errorText(error, "Could not delete the template");
		} finally {
			busy = null;
		}
	}
</script>

<div class="page">
	<header class="head">
		<div>
			<h1>Templates</h1>
			<p class="sub">Pick one, fill in its fields, print.</p>
		</div>
		<label class="search">
			<Search aria-hidden="true" />
			<span class="sr-only">Search templates</span>
			<input type="search" placeholder="Search" bind:value={query} autocomplete="off" />
		</label>
	</header>

	<div class="chips" role="tablist" aria-label="Categories">
		<button
			role="tab"
			type="button"
			aria-selected={filter === "all"}
			onclick={() => (filter = "all")}>All</button
		>
		{#each CATEGORIES.filter((category) => present.has(category.id)) as category (category.id)}
			<button
				role="tab"
				type="button"
				aria-selected={filter === category.id}
				onclick={() => (filter = category.id)}
			>
				{category.name}
			</button>
		{/each}
	</div>

	{#if failure}<Banner tone="danger">{failure}</Banner>{/if}

	{#if templates.load.kind === "failed"}
		<Banner tone="danger">
			{templates.load.message}
			{#snippet action()}<Button size="sm" onclick={() => templates.refresh()}>Retry</Button
				>{/snippet}
		</Banner>
	{:else if templates.load.kind !== "ready"}
		<div class="grid">
			{#each { length: 8 }, index (index)}
				<div class="card skeleton">
					<div class="stage"><Skeleton width="70%" height="44px" /></div>
					<div class="meta">
						<Skeleton width="50%" height="14px" /><Skeleton width="80%" height="12px" />
					</div>
				</div>
			{/each}
		</div>
	{:else}
		{#if filter === "all" && query === ""}
			<button
				class="blank"
				type="button"
				onclick={() => {
					editor.startBlank(editor.doc.tapeMm);
					void goto(resolve("/"));
				}}
			>
				<FilePlusCorner aria-hidden="true" />
				<span><strong>Blank label</strong> Start from an empty strip of tape</span>
			</button>
		{/if}
		{#if groups.length === 0}
			<p class="empty">No templates match "{query}".</p>
		{/if}
		{#each groups as group (group.id)}
			<section>
				<h2>{group.name}</h2>
				<div class="grid">
					{#each group.templates as template (template.id)}
						<article class="card" id={template.id}>
							<button
								class="hit"
								type="button"
								onclick={() => open(template)}
								aria-label="Use {template.name}"
							></button>
							<div class="stage">
								<TapeLabel
									doc={template.doc}
									vars={resolveVars(template.fields, sampleVars(template.fields))}
									maxWidth={248}
									maxHeight={64}
									lazy
								/>
							</div>
							<div class="meta">
								<h3>{template.name}</h3>
								<p>{template.description}</p>
								<div class="foot">
									<span class="num">
										{template.fields.length === 0
											? "No fields"
											: `${String(template.fields.length)} ${template.fields.length === 1 ? "field" : "fields"}`}
										<span class="sep">·</span>
										{template.doc.tapeMm === 4 ? "3.5" : template.doc.tapeMm} mm
									</span>
									<div class="actions">
										{#if template.builtin}
											<span class="tag">Built-in</span>
											<IconButton
												label="Duplicate to edit"
												disabled={busy === template.id}
												onclick={() => duplicateTemplate(template)}><Copy /></IconButton
											>
										{:else}
											<IconButton
												label="Duplicate"
												disabled={busy === template.id}
												onclick={() => duplicateTemplate(template)}><Copy /></IconButton
											>
											<IconButton
												label="Delete"
												onclick={() => {
													deleting = template;
													confirmDelete = true;
												}}><Trash2 /></IconButton
											>
										{/if}
									</div>
								</div>
							</div>
						</article>
					{/each}
				</div>
			</section>
		{/each}
	{/if}
</div>

<Sheet bind:open={confirmDelete} title="Delete template" width="400px">
	<p>Delete <strong>{deleting?.name}</strong>? Past prints keep their copy of the design.</p>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (confirmDelete = false)}>Cancel</Button>
		<Button variant="danger" busy={busy !== null} onclick={remove}>Delete</Button>
	{/snippet}
</Sheet>

<style>
	.page {
		display: grid;
		gap: 20px;
		max-width: 1280px;
		margin-inline: auto;
		padding: 24px 24px 96px;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
	}

	h1 {
		font-size: 22px;
		font-weight: 500;
		line-height: 1.2;
	}

	.sub {
		color: var(--ink-2);
	}

	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		width: min(280px, 100%);
		height: 36px;
		padding-inline: 10px;
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
	}

	.search:focus-within {
		outline: 2px solid var(--accent);
	}

	.search :global(svg) {
		width: 16px;
		height: 16px;
		color: var(--ink-3);
	}

	.search input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		outline: none;
	}

	.chips {
		display: flex;
		gap: 6px;
		margin-inline: -24px;
		padding-inline: 24px;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.chips button {
		flex: none;
		height: 32px;
		padding-inline: 12px;
		border: 0;
		border-radius: 999px;
		background: var(--sunken);
		color: var(--ink-2);
		font-weight: 500;
		cursor: pointer;
		transition:
			background-color var(--fast),
			color var(--fast);
	}

	.chips button:hover {
		color: var(--ink);
	}

	.chips button[aria-selected="true"] {
		background: var(--ink);
		color: var(--panel);
	}

	section {
		display: grid;
		gap: 12px;
	}

	h2 {
		color: var(--ink-2);
		font-size: 13px;
		font-weight: 500;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 12px;
	}

	.card {
		position: relative;
		display: grid;
		grid-template-rows: 112px auto;
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
		overflow: hidden;
		transition:
			box-shadow var(--base) var(--ease-standard),
			transform var(--base) var(--ease);
	}

	.card:not(.skeleton):hover {
		box-shadow: var(--shadow-sheet);
		transform: translateY(-1px);
	}

	.card:has(.hit:active) {
		transform: scale(0.99);
	}

	.hit {
		position: absolute;
		inset: 0;
		z-index: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}

	.hit:focus-visible {
		outline-offset: -2px;
	}

	.stage {
		display: grid;
		place-items: center;
		padding: 16px;
		background: var(--ground);
		--dimension-bg: var(--ground);
		pointer-events: none;
	}

	.meta {
		display: grid;
		gap: 4px;
		padding: 12px 12px 8px 16px;
	}

	h3 {
		font-size: 14px;
		font-weight: 500;
	}

	.meta p {
		color: var(--ink-2);
		font-size: 13px;
		line-height: 1.4;
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 32px;
		color: var(--ink-3);
		font-size: 12px;
	}

	.sep {
		padding-inline: 2px;
	}

	.actions {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.tag {
		margin-inline-end: 4px;
		color: var(--ink-3);
	}

	.blank {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		border: 0;
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
		color: var(--ink-2);
		text-align: start;
		cursor: pointer;
		transition: box-shadow var(--base);
	}

	.blank:hover {
		box-shadow: var(--shadow-sheet);
	}

	.blank strong {
		display: block;
		color: var(--ink);
		font-weight: 500;
	}

	.blank :global(svg) {
		width: 20px;
		height: 20px;
		color: var(--ink-2);
	}

	.empty {
		color: var(--ink-2);
	}

	@media (max-width: 760px) {
		.page {
			padding: 16px 16px 96px;
		}

		.chips {
			margin-inline: -16px;
			padding-inline: 16px;
		}

		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
