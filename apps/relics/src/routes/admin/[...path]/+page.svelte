<script lang="ts">
	import { refreshAll, afterNavigate } from "$app/navigation";
	import { page } from "$app/state";
	import { tick } from "svelte";

	import { command } from "#lib/client.ts";
	import AdminSetup from "#lib/components/AdminSetup.svelte";
	import ImageUpload from "#lib/components/ImageUpload.svelte";
	import TagWriter from "#lib/components/TagWriter.svelte";
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
	afterNavigate(() => {
		message = "";
		error = "";
	});
	let busy = $state(false),
		message = $state(""),
		error = $state("");
	let uploading = $state(false);
	let errorNotice = $state<HTMLParagraphElement>();
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
			errorNotice?.focus();

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

		typeName = value?.name ?? "";
		typeDescription = value?.description ?? "";
		typeImage = value?.imageUrl ?? "";
	}
	function chooseVariety() {
		const value = catalog.varieties.find((v) => v.id === editVariety);

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
<div class="page-heading">
	<div>
		<h1>Relics workshop</h1>
		<p>
			{catalog.relics.length} relics · {catalog.types.length} types · {catalog.varieties.length} varieties
		</p>
	</div>
	<form method="POST" action="/logout"><button class="btn btn-ghost">Sign out</button></form>
</div>
<nav class="admin-tabs" aria-label="Admin tools">
	{#each tabs.filter(([path]) => path === "" || path === "allocate" || path === "nfc-writer") as [path, label] (path)}<a
			href="/admin{path ? `/${path}` : ''}"
			class:chosen={tab === path}
			aria-current={tab === path ? "page" : undefined}>{label}</a
		>{/each}
	<details class="more-tools" open={!["", "allocate", "nfc-writer"].includes(tab)}>
		<summary>Edit catalog &amp; more</summary>
		<div class="more-links">
			{#each tabs.filter(([path]) => path !== "" && path !== "allocate" && path !== "nfc-writer") as [path, label] (path)}<a
					href="/admin/{path}"
					class:chosen={tab === path}
					aria-current={tab === path ? "page" : undefined}>{label}</a
				>{/each}
		</div>
	</details>
</nav>
{#if message && tab !== ""}<p class="message" role="status">{message}</p>{/if}{#if error}<p
		class="message error"
		role="alert"
		bind:this={errorNotice}
		tabindex="-1"
	>
		{error}
	</p>{/if}
{#if tab === "" || tab === "allocate"}
	{#key tab}<AdminSetup {catalog} {save} {busy} makeTags={tab === "allocate"} />{/key}
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
			><ImageUpload bind:busy={uploading} bind:url={typeImage} /><button
				class="btn btn-primary"
				disabled={busy || uploading}>{editType ? "Save type" : "Create type"}</button
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
			><ImageUpload bind:busy={uploading} bind:url={varietyImage} /><button
				class="btn btn-primary"
				disabled={busy || uploading}>{editVariety ? "Save variety" : "Create variety"}</button
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
		<h2>Specimen artwork & label</h2>
		<p class="inline-help">
			Set an individual specimen’s artwork. For a type or variety photo, use Edit catalog.
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
			><ImageUpload bind:busy={uploading} bind:url={relicImage} /><button
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
			<ImageUpload bind:busy={uploading} bind:url={setImage} />
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
				<button class="btn btn-primary" disabled={busy || !setVarieties.length}
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
	{#key page.url.search}<TagWriter {catalog} {save} {busy} />{/key}
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
	.admin-tabs {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-block-end: 40px;
		border-block-end: 1px solid var(--rule);
		padding-block-end: 8px;
	}
	.admin-tabs a {
		min-height: 48px;
		padding: 12px 20px;
		text-decoration: none;
		color: var(--muted);
	}
	.admin-tabs a.chosen {
		background: var(--color-base-200);
		color: var(--color-primary);
	}
	.page-heading h1 {
		font-size: 2.5rem;
	}
	.more-tools {
		margin-inline-start: auto;
	}
	.more-tools summary {
		padding-inline: 16px;
		color: var(--muted);
	}
	.more-links {
		display: flex;
		flex-wrap: wrap;
	}
	.admin-columns {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 64px;
	}
	.admin-form {
		max-width: 600px;
	}
	.admin-columns h2,
	.admin-form h2 {
		margin-block-end: 24px;
		font-size: 1.5rem;
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
		.admin-tabs {
			margin-inline: -20px;
			padding-inline: 20px;
		}
		.admin-tabs a {
			padding-inline: 16px;
		}
		table {
			font-size: 0.875rem;
		}
	}
</style>
