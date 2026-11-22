<script lang="ts">
	import { refreshAll } from "$app/navigation";
	import { page } from "$app/state";
	import { Copy, Check } from "@lucide/svelte";

	import { command } from "#lib/client.ts";
	import ImageUpload from "#lib/components/ImageUpload.svelte";
	import type { AdminCommand } from "#lib/schema.ts";
	let { data }: import("./$types").PageProps = $props();
	let catalog = $derived(data.catalog);
	const tabs = [
		["", "Catalog"],
		["allocate", "Allocate"],
		["images", "Artwork"],
		["lore", "Lore"],
		["sets", "Sets"],
		["nfc-writer", "Write tags"],
	];
	let tab = $derived(page.params.path ?? "");
	let busy = $state(false),
		message = $state(""),
		error = $state("");
	let typeId = $state(1),
		varietyId = $state(1),
		start = $state(0),
		end = $state(15),
		lore = $state("");
	let editType = $state(0),
		typeName = $state(""),
		typeDescription = $state(""),
		typeImage = $state("");
	let editVariety = $state(0),
		varietyName = $state(""),
		varietyDescription = $state(""),
		varietyImage = $state(""),
		varietyType = $state(1);
	let rangeId = $state(1);
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
	let writerVariety = $state(1),
		writerIndex = $state(0),
		copyMessage = $state("");
	let writerRelics = $derived(
		catalog.relics
			.filter((r) => r.varietyId === writerVariety)
			.sort((a, b) => (a.indexNumber ?? 0) - (b.indexNumber ?? 0)),
	);
	let writer = $derived(writerRelics.at(writerIndex));
	let writerUrl = $derived(writer ? `${page.url.origin}/relics/${writer.id}` : "");
	async function save(input: AdminCommand) {
		busy = true;
		message = "";
		error = "";

		try {
			await command("admin/command", input);
			await refreshAll();
			message = "Saved.";
		} catch (e) {
			error = e instanceof Error ? e.message : "Could not save.";
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
	async function chooseRelic() {
		const selected = catalog.relics.find((r) => r.id === selectedRelic);

		if (!selected) {
			return;
		}

		relicName = selected.name;
		const response = await fetch(`/api/v1/relics/${selected.id}`);

		if (response.ok) {
			const { Schema } = await import("effect");
			const { RelicCard } = await import("#lib/schema.ts");
			const record = Schema.decodeUnknownSync(RelicCard)(await response.json());

			relicDescription = record.description ?? "";
			relicLore = record.lore ?? "";
			relicImage = record.imageUrl ?? "";
		}
	}
	async function copy() {
		copyMessage = "";

		try {
			await navigator.clipboard.writeText(writerUrl);
			copyMessage = "URL copied.";
		} catch {
			copyMessage = "Select the URL below and copy it.";
		}
	}
	function markWritten() {
		if (!writer) {
			return;
		}

		const range = catalog.ranges.find(
			(r) =>
				r.varietyId === writer.varietyId &&
				(r.startIndex === null || r.startIndex <= (writer.indexNumber ?? 0)) &&
				(r.endIndex === null || r.endIndex >= (writer.indexNumber ?? 0)),
		);

		if (!range) {
			error = "No allocation range for this relic.";

			return;
		}

		void save({ kind: "written", rangeId: range.id, index: writer.indexNumber ?? 0 });
	}
</script>

<svelte:head><title>Admin · Petal Relics</title></svelte:head>
<div class="page-heading">
	<div>
		<h1>The catalog.</h1>
		<p>
			{catalog.relics.length} relics · {catalog.types.length} types · {catalog.varieties.length} varieties
		</p>
	</div>
	<form method="POST" action="/logout"><button class="btn btn-ghost">Sign out</button></form>
</div>
<nav class="admin-tabs" aria-label="Admin tools">
	{#each tabs as [path, label] (path)}<a
			href="/admin{path ? `/${path}` : ''}"
			class:chosen={tab === path}>{label}</a
		>{/each}
</nav>
{#if message}<p class="message" role="status">{message}</p>{/if}{#if error}<p
		class="message error"
		role="alert"
	>
		{error}
	</p>{/if}
{#if tab === "" || tab === "types" || tab === "varieties"}
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
			><ImageUpload bind:url={typeImage} /><button class="btn btn-primary" disabled={busy}
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
			><ImageUpload bind:url={varietyImage} /><button class="btn btn-primary" disabled={busy}
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
			><button class="btn btn-primary" disabled={busy}>Update ownership</button>
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
{:else if tab === "allocate"}
	<div class="admin-columns">
		<form
			onsubmit={(e) => {
				submit(e, { kind: "allocate", typeId, varietyId, start, end, lore });
			}}
		>
			<h2>Allocate a range</h2>
			<p class="inline-help">
				Create up to 500 tag records at once. Existing ranges cannot overlap. The original tag ID
				encoding is preserved.
			</p>
			<label class="field"
				><span>Type</span><select
					class="select"
					bind:value={typeId}
					onchange={() => (varietyId = catalog.varieties.find((v) => v.typeId === typeId)?.id ?? 0)}
					>{#each catalog.types as type (type.id)}<option value={type.id}>{type.name}</option
						>{/each}</select
				></label
			><label class="field"
				><span>Variety</span><select class="select" bind:value={varietyId}
					>{#each catalog.varieties.filter((v) => v.typeId === typeId) as variety (variety.id)}<option
							value={variety.id}>{variety.name}</option
						>{/each}</select
				></label
			>
			<div class="admin-columns tight">
				<label class="field"
					><span>Start index</span><input
						class="input"
						type="number"
						min="0"
						max="65535"
						required
						bind:value={start}
					/></label
				><label class="field"
					><span>End index</span><input
						class="input"
						type="number"
						min={start}
						max={Math.min(start + 499, 65535)}
						required
						bind:value={end}
					/></label
				>
			</div>
			<label class="field"
				><span>Official lore (optional)</span><textarea
					class="textarea"
					maxlength="4000"
					bind:value={lore}></textarea></label
			>
			<p class="inline-help">{end >= start ? end - start + 1 : 0} relics will be created.</p>
			<button class="btn btn-primary" disabled={busy}>Allocate relics</button>
		</form>
		<section>
			<h2>Existing allocations</h2>
			{#each catalog.ranges as range (range.id)}<div class="range rule">
					<h3>{catalog.varieties.find((v) => v.id === range.varietyId)?.name}</h3>
					<p class="muted mono">
						{range.startIndex ?? "Open start"} to {range.endIndex ?? "open end"}
					</p>
					<p class="small">{range.lore ?? "No lore added."}</p>
				</div>{/each}
		</section>
	</div>
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
			Set an individual specimen’s artwork. For a type or variety, use Catalog. Uploaded files
			remain outside the repository.
		</p>
		<label class="field"
			><span>Relic</span><select
				class="select"
				required
				bind:value={selectedRelic}
				onchange={() => void chooseRelic()}
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
			><ImageUpload bind:url={relicImage} /><button class="btn btn-primary" disabled={busy}
				>Save specimen</button
			>{/if}
	</form>
{:else if tab === "lore"}
	<form
		class="admin-form"
		onsubmit={(e) => {
			submit(e, { kind: "range", id: rangeId, lore: rangeLore });
		}}
	>
		<h2>Allocation lore</h2>
		<label class="field"
			><span>Allocation</span><select
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
		><button class="btn btn-primary" disabled={busy}>Save lore</button>
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
			<ImageUpload bind:url={setImage} />
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
			{#each data.collection.sets as set (set.id)}<div class="range rule">
					<h3>{set.name}</h3>
					<p class="muted">{set.varietyIds.length} varieties</p>
				</div>{:else}<p class="inline-help">
					No named sets yet. Collections show varieties grouped by type.
				</p>{/each}
		</section>
	</div>
{:else if tab === "nfc-writer"}
	<div class="admin-columns">
		<section>
			<h2>Write a physical tag</h2>
			<p class="inline-help">
				In NFC Tools, choose Write → Add a record → URL / URI. Paste this exact URL, write it to the
				tag, then tap it to check. The same URL can be printed as a QR code.
			</p>
			<label class="field"
				><span>Variety</span><select
					class="select"
					bind:value={writerVariety}
					onchange={() => {
						writerIndex = 0;
						copyMessage = "";
					}}
					>{#each catalog.varieties as variety (variety.id)}<option value={variety.id}
							>{variety.typeName} / {variety.name}</option
						>{/each}</select
				></label
			>{#if writer}<div class="writer rule">
					<h3>{writer.name}</h3>
					<label class="field"
						><span>Tag URL</span><input
							class="input mono"
							readonly
							value={writerUrl}
							onclick={(e) => {
								e.currentTarget.select();
							}}
						/></label
					>
					<div class="actions">
						<button class="btn btn-primary" onclick={copy}><Copy size={16} />Copy URL</button><a
							class="btn btn-ghost"
							href={writerUrl}
							target="_blank"
							rel="noreferrer">Check specimen</a
						>
					</div>
					{#if copyMessage}<p role="status" class="inline-help">{copyMessage}</p>{/if}
					<div class="writer-navigation">
						<button
							class="btn btn-ghost"
							disabled={writerIndex === 0}
							onclick={() => {
								writerIndex--;
								copyMessage = "";
							}}>Previous</button
						><span class="muted mono">{writerIndex + 1} / {writerRelics.length}</span><button
							class="btn btn-ghost"
							disabled={writerIndex >= writerRelics.length - 1}
							onclick={() => {
								writerIndex++;
								copyMessage = "";
							}}>Next</button
						>
					</div>
					<button class="btn btn-neutral" disabled={busy} onclick={markWritten}
						><Check size={16} />Mark written</button
					>
				</div>{:else}<p class="message">Allocate this variety before writing tags.</p>{/if}
		</section>
		<section>
			<h2>Writing notes</h2>
			<div class="range rule">
				<h3>Keep existing tags as they are.</h3>
				<p class="muted">
					The catalog ID and /relics/ URL never change. There is no need to rewrite an existing tag.
				</p>
			</div>
			<div class="range rule">
				<h3>Check before locking.</h3>
				<p class="muted">
					Hold the tag near the phone’s NFC reader, open the URL and confirm its variety and number.
					Test first, then lock only if you intend it to be permanent.
				</p>
			</div>
			<div class="range rule">
				<h3>Physical test required.</h3>
				<p class="muted">
					The website copies URLs and records writing progress. The NFC Tools app writes the tag.
				</p>
			</div>
		</section>
	</div>
{:else}<p class="message">Choose a tool from the navigation above.</p>{/if}

<dialog bind:this={setDialog}>
	<h2>Delete this set?</h2>
	<p>This removes the grouping. Every relic and its owner stay in the catalog.</p>
	<div class="actions">
		<button
			class="btn btn-primary"
			disabled={busy}
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
		overflow-x: auto;
		margin-block-end: 40px;
		border-block-end: 1px solid var(--rule);
		padding-block-end: 8px;
	}
	.admin-tabs a {
		min-height: 48px;
		padding: 12px 20px;
		white-space: nowrap;
		text-decoration: none;
		color: var(--muted);
	}
	.admin-tabs a.chosen {
		background: var(--color-base-200);
		color: var(--color-primary);
	}
	.admin-columns {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 64px;
	}
	.admin-columns.tight {
		gap: 16px;
	}
	.admin-form {
		max-width: 600px;
	}
	.admin-columns h2,
	.admin-form h2 {
		margin-block-end: 24px;
		font-size: 1.5rem;
	}
	.range {
		padding-block: 24px;
	}
	.range p {
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
	.writer {
		padding-block: 24px;
	}
	.writer-navigation {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-block: 32px;
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
		.admin-columns.tight {
			grid-template-columns: 1fr 1fr;
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
