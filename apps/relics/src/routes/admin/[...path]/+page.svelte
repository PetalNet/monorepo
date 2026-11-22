<script lang="ts">
	import { goto, refreshAll, afterNavigate } from "$app/navigation";
	import { page } from "$app/state";
	import { tick } from "svelte";

	import { command } from "#lib/client.ts";
	import CreatureColorField from "#lib/components/CreatureColorField.svelte";
	import CreatureModelField from "#lib/components/CreatureModelField.svelte";
	import TagWriter from "#lib/components/TagWriter.svelte";
	import UploadField from "#lib/components/UploadField.svelte";
	import Workshop from "#lib/components/Workshop.svelte";
	import type { CreatureModelId } from "#lib/creatures.ts";
	import type { AdminCommand } from "#lib/schema.ts";
	let { data }: import("./$types").PageProps = $props();
	let catalog = $derived(data.catalog);
	const tabs = [
		["", "Start here"],
		["catalog", "Edit catalog"],
		["allocate", "Make tags"],
		["images", "Individual relics"],
		["lore", "Batch stories"],
		["sets", "Sets"],
		["nfc-writer", "Write tags"],
	];
	let tab = $derived(page.params.path ?? "");
	let writing = $state(false);
	afterNavigate(() => {
		message = "";
		error = "";
	});
	let busy = $state(false),
		message = $state(""),
		error = $state("");
	let uploading = $state(false);
	let errorNotice = $state<HTMLParagraphElement>();
	let typeModel = $state<CreatureModelId | null>(null);
	let varietyColor = $state("");
	let editType = $state(0),
		typeName = $state(""),
		typeDescription = $state(""),
		typeImage = $state("");
	let editVariety = $state(0),
		varietyName = $state(""),
		varietyDescription = $state(""),
		varietyImage = $state(""),
		varietyType = $state(0);
	let rangeId = $state(0);
	let rangeLore = $derived(catalog.ranges.find((r) => r.id === rangeId)?.lore ?? "");
	let target = $state(""),
		selectedRelic = $state(""),
		relicName = $state(""),
		relicDescription = $state(""),
		relicLore = $state(""),
		relicImage = $state("");
	let setName = $state(""),
		setVarieties = $state<number[]>([]);
	let setId = $state(0),
		setDescription = $state(""),
		setImage = $state("");
	let setDialog: HTMLDialogElement;
	function chooseSet() {
		const set = data.collection.sets.find((s) => s.id === setId);

		setName = set?.name ?? "";
		setDescription = set?.description ?? "";
		setImage = set?.imageUrl ?? "";
		setVarieties = [...(set?.varietyIds ?? [])];
	}
	$effect(() => {
		if (!catalog.types.some((t) => t.id === varietyType)) {
			varietyType = catalog.types.at(0)?.id ?? 0;
		}

		if (!catalog.ranges.some((r) => r.id === rangeId)) {
			rangeId = catalog.ranges.at(0)?.id ?? 0;
		}
	});
	async function save(input: AdminCommand) {
		busy = true;
		message = "";
		error = "";

		try {
			await command("admin/command", input);
			await refreshAll();
			message = "Saved.";

			return true;
		} catch (e) {
			error = e instanceof Error ? e.message : "Could not save. Please try again.";
			await tick();

			if (!writing) {
				errorNotice?.focus();
			}

			return false;
		} finally {
			busy = false;
		}
	}
	function submit(event: SubmitEvent, input: AdminCommand) {
		event.preventDefault();
		void save(input);
	}
	function chooseType() {
		const value = catalog.types.find((t) => t.id === editType);

		typeModel = value?.modelId ?? null;
		typeName = value?.name ?? "";
		typeDescription = value?.description ?? "";
		typeImage = value?.imageUrl ?? "";
	}
	function chooseVariety() {
		const value = catalog.varieties.find((v) => v.id === editVariety);

		varietyColor = value?.color ?? "";
		varietyName = value?.name ?? "";
		varietyDescription = value?.description ?? "";
		varietyImage = value?.imageUrl ?? "";
		varietyType = value?.typeId ?? catalog.types.at(0)?.id ?? 1;
	}
	function chooseRelic() {
		const selected = catalog.relics.find((r) => r.id === selectedRelic);

		relicName = selected?.name ?? "";
		relicDescription = selected?.description ?? "";
		relicLore = selected?.lore ?? "";
		relicImage = selected?.imageUrl ?? "";
	}
</script>

<svelte:head><title>Admin · Petal Relics</title></svelte:head>
<div class="page-heading" hidden={tab === "nfc-writer"}>
	{#if tab !== "nfc-writer"}<h1>
			{tab === ""
				? "Relics workshop"
				: (tabs.find(([path]) => path === tab)?.[1] ?? "Edit catalog")}
		</h1>{/if}
</div>
<nav class="admin-tools" aria-label="Admin tools" hidden={writing}>
	<label class="tool-picker"
		><span class="visually-hidden">Workshop tool</span><select
			class="select"
			value={["types", "varieties"].includes(tab) ? "catalog" : tab}
			onchange={(event) => {
				const path = event.currentTarget.value;

				void goto(`/admin${path ? `/${path}` : ""}`);
			}}
			>{#each tabs as [path, label] (path)}<option value={path}>{label}</option>{/each}</select
		></label
	>
	<form method="POST" action="/logout"><button class="btn btn-ghost">Sign out</button></form>
</nav>
{#if message && tab !== "" && !writing}<p class="message" role="status">
		{message}
	</p>{/if}{#if error}<p class="message error" role="alert" bind:this={errorNotice} tabindex="-1">
		{error}
	</p>{/if}
{#if tab === "" || tab === "allocate"}
	{#key tab}<Workshop {catalog} {save} {busy} makeTags={tab === "allocate"} />{/key}
{:else if tab === "catalog" || tab === "types" || tab === "varieties"}
	<section class="admin-columns">
		<form
			onsubmit={(e) => {
				submit(e, {
					kind: "type",
					...(editType ? { id: editType } : {}),
					name: typeName,
					description: typeDescription,
					imageUrl: typeImage,
					modelId: typeModel,
				});
			}}
		>
			<h2>Types</h2>
			<label class="field"
				><span>Edit or create</span><select
					class="select"
					bind:value={editType}
					onchange={chooseType}
					><option value={0}>Create a type</option>{#each catalog.types as type (type.id)}<option
							value={type.id}>{type.name}</option
						>{/each}</select
				></label
			><label class="field"
				><span>Name</span><input
					class="input"
					required
					maxlength="80"
					bind:value={typeName}
				/></label
			><label class="field"
				><span>Description</span><textarea
					class="textarea"
					maxlength="4000"
					bind:value={typeDescription}></textarea></label
			><CreatureModelField bind:value={typeModel} /><UploadField
				bind:busy={uploading}
				bind:url={typeImage}
			/><button class="btn btn-primary" disabled={busy || uploading}
				>{editType ? "Save type" : "Create type"}</button
			>
		</form>
		<form
			onsubmit={(e) => {
				submit(e, {
					kind: "variety",
					...(editVariety ? { id: editVariety } : {}),
					typeId: varietyType,
					name: varietyName,
					description: varietyDescription,
					imageUrl: varietyImage,
					color: varietyColor || null,
				});
			}}
		>
			<h2>Varieties</h2>
			<label class="field"
				><span>Edit or create</span><select
					class="select"
					bind:value={editVariety}
					onchange={chooseVariety}
					><option value={0}>Create a variety</option
					>{#each catalog.varieties as variety (variety.id)}<option value={variety.id}
							>{variety.typeName} / {variety.name}</option
						>{/each}</select
				></label
			><label class="field"
				><span>Type</span><select class="select" bind:value={varietyType} disabled={!!editVariety}
					>{#each catalog.types as type (type.id)}<option value={type.id}>{type.name}</option
						>{/each}</select
				></label
			><label class="field"
				><span>Name</span><input
					class="input"
					required
					maxlength="80"
					bind:value={varietyName}
				/></label
			><label class="field"
				><span>Description</span><textarea
					class="textarea"
					maxlength="4000"
					bind:value={varietyDescription}></textarea></label
			><CreatureColorField bind:value={varietyColor} /><UploadField
				bind:busy={uploading}
				bind:url={varietyImage}
			/><button class="btn btn-primary" disabled={busy || uploading}
				>{editVariety ? "Save variety" : "Create variety"}</button
			>
		</form>
	</section>
	<section>
		<div class="section-heading">
			<h2>Ownership</h2>
			<span class="muted">Visible to admins only</span>
		</div>
		<form
			class="reassign"
			onsubmit={(e) => {
				submit(e, { kind: "reassign", relicId: selectedRelic, target });
			}}
		>
			<label class="field"
				><span>Relic</span><select class="select" required bind:value={selectedRelic}
					><option value="">Choose a relic</option>{#each catalog.relics as relic (relic.id)}<option
							value={relic.id}>{relic.name} · {relic.id}</option
						>{/each}</select
				></label
			><label class="field"
				><span>Assign to</span><select class="select" bind:value={target}
					><option value="">Release (unclaimed)</option
					>{#each catalog.collectors as owner (owner.id)}<option value={`collector:${owner.id}`}
							>{owner.name} · device collection</option
						>{/each}{#each catalog.legacyOwners as owner (owner.id)}<option
							value={`legacy:${owner.id}`}>{owner.name} · legacy</option
						>{/each}</select
				></label
			><button class="btn btn-primary" disabled={busy || uploading}>Update ownership</button>
		</form>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Specimen</th><th>Catalog ID</th><th>Owner</th></tr></thead><tbody
					>{#each catalog.relics as relic (relic.id)}<tr
							><td><a href="/relics/{relic.id}">{relic.name}</a></td><td><code>{relic.id}</code></td
							><td
								>{catalog.collectors.find((c) => c.id === relic.collectorId)?.name ??
									catalog.legacyOwners.find((c) => c.id === relic.ownerId)?.name ??
									"Unclaimed"}</td
							></tr
						>{/each}</tbody
				>
			</table>
		</div>
	</section>
{:else if tab === "images"}
	<form
		class="admin-form"
		onsubmit={(e) => {
			submit(e, {
				kind: "relic",
				relicId: selectedRelic,
				name: relicName,
				description: relicDescription,
				lore: relicLore,
				imageUrl: relicImage,
			});
		}}
	>
		<h2>A photo and a little story</h2>
		<p class="inline-help">
			Edit one relic here. For a whole type or color, choose Edit catalog from the menu.
		</p>
		<label class="field"
			><span>Relic</span><select
				class="select"
				required
				bind:value={selectedRelic}
				onchange={chooseRelic}
				><option value="">Choose a relic</option>{#each catalog.relics as relic (relic.id)}<option
						value={relic.id}>{relic.name}</option
					>{/each}</select
			></label
		>{#if selectedRelic}<label class="field"
				><span>Name</span><input
					class="input"
					required
					maxlength="80"
					bind:value={relicName}
				/></label
			><label class="field"
				><span>Description</span><textarea
					class="textarea"
					maxlength="4000"
					bind:value={relicDescription}></textarea></label
			><label class="field"
				><span>Lore</span><textarea class="textarea" maxlength="4000" bind:value={relicLore}
				></textarea></label
			><UploadField bind:busy={uploading} bind:url={relicImage} /><button
				class="btn btn-primary"
				disabled={busy || uploading}>Save specimen</button
			>{/if}
	</form>
{:else if tab === "lore"}
	<form
		class="admin-form"
		onsubmit={(e) => {
			submit(e, { kind: "range", id: rangeId, lore: rangeLore });
		}}
	>
		<h2>Batch stories</h2>
		<label class="field"
			><span>Tag batch</span><select
				class="select"
				bind:value={rangeId}
				onchange={() => (rangeLore = catalog.ranges.find((r) => r.id === rangeId)?.lore ?? "")}
				>{#each catalog.ranges as range (range.id)}<option value={range.id}
						>{catalog.varieties.find((v) => v.id === range.varietyId)?.name} · {range.startIndex ??
							"open"}–{range.endIndex ?? "open"}</option
					>{/each}</select
			></label
		><label class="field"
			><span>Official lore</span><textarea
				class="textarea"
				rows="6"
				maxlength="4000"
				bind:value={rangeLore}></textarea></label
		><button class="btn btn-primary" disabled={busy || uploading}>Save lore</button>
	</form>
{:else if tab === "sets"}
	<div class="admin-columns">
		<form
			onsubmit={(e) => {
				submit(e, {
					kind: "set",
					...(setId ? { id: setId } : {}),
					name: setName,
					description: setDescription,
					imageUrl: setImage,
					varietyIds: setVarieties,
				});
			}}
		>
			<h2>{setId ? "Edit set" : "Create a set"}</h2>
			<label class="field"
				><span>Edit or create</span><select class="select" bind:value={setId} onchange={chooseSet}
					><option value={0}>Create a set</option
					>{#each data.collection.sets as set (set.id)}<option value={set.id}>{set.name}</option
						>{/each}</select
				></label
			>
			<label class="field"
				><span>Name</span><input
					class="input"
					required
					maxlength="80"
					bind:value={setName}
				/></label
			>
			<label class="field"
				><span>Description</span><textarea
					class="textarea"
					maxlength="4000"
					bind:value={setDescription}></textarea></label
			>
			<UploadField bind:busy={uploading} bind:url={setImage} />
			<fieldset>
				<legend class="muted small">Varieties</legend
				>{#each catalog.varieties as variety (variety.id)}<label class="check-row"
						><input
							type="checkbox"
							class="checkbox"
							value={variety.id}
							bind:group={setVarieties}
						/>{variety.typeName} / {variety.name}</label
					>{/each}
			</fieldset>
			<div class="actions">
				<button class="btn btn-primary" disabled={busy || uploading || !setVarieties.length}
					>{setId ? "Save set" : "Create set"}</button
				>{#if setId}<button
						class="btn btn-ghost"
						type="button"
						onclick={() => {
							setDialog.showModal();
						}}>Delete set</button
					>{/if}
			</div>
		</form>
		<section>
			<h2>Sets</h2>
			{#each data.collection.sets as set (set.id)}<div class="record-row rule">
					<h3>{set.name}</h3>
					<p class="muted">{set.varietyIds.length} varieties</p>
				</div>{:else}<p class="inline-help">
					No named sets yet. Collections show varieties grouped by type.
				</p>{/each}
		</section>
	</div>
{:else if tab === "nfc-writer"}
	{#key page.url.search}<TagWriter
			{catalog}
			{save}
			{busy}
			onactive={(active: boolean) => {
				writing = active;
			}}
		/>{/key}
{:else}<p class="message">Choose a tool from the navigation above.</p>{/if}

<dialog bind:this={setDialog}>
	<h2>Delete this set?</h2>
	<p>This removes the grouping. Every relic and its owner stay in the catalog.</p>
	<div class="actions">
		<button
			class="btn btn-primary"
			disabled={busy || uploading}
			onclick={async () => {
				await save({ kind: "deleteSet", id: setId });
				setDialog.close();
				setId = 0;
				chooseSet();
			}}>Delete set</button
		><button
			class="btn btn-ghost"
			onclick={() => {
				setDialog.close();
			}}>Cancel</button
		>
	</div>
</dialog>

<style>
	[hidden] {
		display: none !important;
	}
	.admin-tools {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 32px;
	}
	.tool-picker {
		flex: 1;
		min-width: 0;
		max-width: 400px;
	}
	.tool-picker select {
		min-width: 0;
		font-weight: 700;
	}
	.admin-tools .btn {
		padding-inline: 12px;
		white-space: nowrap;
	}
	.page-heading {
		margin-bottom: 24px;
	}
	.page-heading:empty {
		display: none;
	}
	.page-heading h1 {
		font: 500 2.3125rem/1.14 var(--font-display, Lora, serif);
	}
	.btn {
		border-radius: 8px;
		min-height: 48px;
		white-space: normal;
		font-weight: 700;
	}
	.select,
	.input,
	.textarea {
		min-width: 0;
		border-radius: 6px;
	}
	.admin-columns {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 48px;
		margin-bottom: 40px;
	}
	.admin-columns > *,
	.admin-form,
	.field {
		min-width: 0;
	}
	.admin-form {
		max-width: 600px;
	}
	.admin-columns h2,
	.admin-form h2 {
		margin-block-end: 24px;
		font: 500 1.625rem/1.2 var(--font-display, Lora, serif);
	}
	.record-row {
		padding-block: 24px;
	}
	.record-row p {
		margin-block-start: 8px;
	}
	.reassign {
		display: grid;
		grid-template-columns: 1fr 1fr auto;
		align-items: end;
		gap: 16px;
		margin-block-end: 32px;
	}
	.reassign .field {
		margin: 0;
	}
	fieldset {
		padding: 16px 0;
		border: none;
	}
	.check-row {
		display: flex;
		gap: 16px;
		align-items: center;
		min-height: 48px;
	}
	.checkbox {
		border: 1px solid var(--muted);
	}
	@media (max-width: 800px) {
		.admin-columns {
			grid-template-columns: 1fr;
			gap: 48px;
		}
		.reassign {
			grid-template-columns: 1fr;
		}
		table {
			font-size: 0.875rem;
		}
	}
	@media (max-width: 540px) {
		form > .btn-primary {
			width: 100%;
		}
		.admin-columns {
			gap: 40px;
		}
		.table-wrap {
			overflow: visible;
		}
		thead {
			display: none;
		}
		tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			padding-block: 16px;
			border-bottom: 1px solid var(--rule);
		}
		td {
			border: 0;
			padding: 4px 0;
			min-width: 0;
			overflow-wrap: anywhere;
		}
		td:first-child {
			grid-column: 1 / -1;
			font-weight: 700;
		}
		td:last-child {
			text-align: end;
		}
	}
</style>
