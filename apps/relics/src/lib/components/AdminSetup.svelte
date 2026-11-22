<script lang="ts">
	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import type { PageData } from "../../routes/admin/[...path]/$types";
	import type { AdminCommand } from "../schema";
	import ImageUpload from "./ImageUpload.svelte";

	let {
		catalog,
		save,
		busy,
		makeTags = false,
	}: {
		catalog: PageData["catalog"];
		save: (input: AdminCommand) => Promise<boolean>;
		busy: boolean;
		makeTags?: boolean;
	} = $props();
	let step = $state<"home" | "type" | "variety" | "batch">("home");
	let typeId = $state(0),
		varietyId = $state(0);
	let name = $state(""),
		description = $state(""),
		image = $state("");
	let uploading = $state(false);
	let quantity = $state(16),
		customStart = $state(0),
		manual = $state(false),
		lore = $state("");
	let added = $state("");
	let varieties = $derived(catalog.varieties.filter((v) => v.typeId === typeId));
	let nextNumber = $derived(
		Math.max(
			-1,
			...catalog.relics.filter((r) => r.varietyId === varietyId).map((r) => r.indexNumber ?? -1),
		) + 1,
	);
	let start = $derived(manual ? customStart : nextNumber);
	let end = $derived(start + quantity - 1);
	$effect(() => {
		if (!catalog.types.some((t) => t.id === typeId)) {
			typeId = catalog.types[0]?.id ?? 0;
		}

		if (!varieties.some((v) => v.id === varietyId)) {
			varietyId = varieties[0]?.id ?? 0;
		}
	});
	$effect(() => {
		if (makeTags) {
			step = "batch";
		}
	});
	function begin(next: typeof step) {
		step = next;
		added = "";
		name = "";
		description = "";
		image = "";
	}
	async function createType(event: SubmitEvent) {
		event.preventDefault();
		const submittedName = name.trim();

		if (await save({ kind: "type", name, description, imageUrl: image })) {
			typeId = catalog.types.find((t) => t.name === submittedName)?.id ?? typeId;
			begin("variety");
			added = "Type saved. Now add its first variety.";
		}
	}
	async function createVariety(event: SubmitEvent) {
		event.preventDefault();
		const submittedName = name.trim();

		if (await save({ kind: "variety", typeId, name, description, imageUrl: image })) {
			added = `${name} saved. Add another variety, or continue to make tags.`;

			varietyId =
				catalog.varieties.find((v) => v.typeId === typeId && v.name === submittedName)?.id ?? 0;

			name = "";
			description = "";
			image = "";
		}
	}
	async function batch(event: SubmitEvent) {
		event.preventDefault();

		const batchStart = start,
			batchEnd = end,
			batchVariety = varietyId;

		if (
			await save({
				kind: "allocate",
				typeId,
				varietyId: batchVariety,
				start: batchStart,
				end: batchEnd,
				lore,
			})
		) {
			await goto(
				`/admin/nfc-writer?${new URLSearchParams({ variety: String(batchVariety), start: String(batchStart), end: String(batchEnd) })}`,
			);
		}
	}
</script>

{#if step === "home"}
	<section class="start-work">
		<div>
			<h2>From a new creature to a finished tag.</h2>
			<p>
				Add its name, add the varieties and their photos, then make a batch of tag links. Write each
				link to a physical NFC tag and check it off here.
			</p>
			<button
				class="btn btn-primary"
				onclick={() => {
					begin("type");
				}}>Add a new relic type</button
			>
		</div>
		<ol class="route-list">
			<li><strong>Name the type</strong><span>A kind of creature, such as Snail.</span></li>
			<li>
				<strong>Add its varieties</strong><span>Each color or design gets a name and photo.</span>
			</li>
			<li>
				<strong>Make and write tags</strong><span
					>Choose how many, then follow the writing checklist.</span
				>
			</li>
		</ol>
	</section>
	<section class="rule existing">
		<h2>Continue with an existing type</h2>
		{#each catalog.types as type (type.id)}
			<div class="type-row">
				<div>
					<h3>{type.name}</h3>
					<p class="muted">
						{catalog.varieties.filter((v) => v.typeId === type.id).length} varieties · {catalog.relics.filter(
							(r) => r.typeId === type.id,
						).length} tags
					</p>
				</div>
				<div class="actions">
					<button
						class="btn btn-ghost"
						onclick={() => {
							typeId = type.id;
							begin("variety");
						}}>Add a variety</button
					><button
						class="btn btn-neutral"
						onclick={() => {
							typeId = type.id;
							begin("batch");
						}}>Make tags</button
					>
				</div>
			</div>
		{:else}<p class="inline-help">No types yet. Add your first relic type above.</p>{/each}
		<a class="btn btn-ghost" href="/admin/nfc-writer">Resume writing tags</a>
	</section>
{:else}
	<div class="setup-layout">
		<section class="setup-form">
			<a
				class="back-link"
				href="/admin"
				onclick={(event) => {
					if (page.url.pathname === "/admin") {
						event.preventDefault();
						step = "home";
					}
				}}>Back to workshop</a
			>
			{#if added}<p class="message" role="status">{added}</p>{/if}
			{#if step === "type"}
				<h2>Add a new relic type</h2>
				<p class="inline-help">
					A type is a kind of creature, such as Snail. You will add its colors or designs as
					varieties next.
				</p>
				<form inert={busy} onsubmit={createType}>
					<label class="field"
						><span>Type name</span><input
							class="input"
							required
							maxlength="80"
							bind:value={name}
							placeholder="For example, Snail"
						/></label
					>
					<details>
						<summary>Description and type photo (optional)</summary><label class="field"
							><span>Description</span><textarea
								class="textarea"
								maxlength="4000"
								bind:value={description}></textarea></label
						><ImageUpload bind:url={image} bind:busy={uploading} />
					</details>
					<button class="btn btn-primary" disabled={busy || uploading}
						>{busy ? "Saving type…" : "Save type and add varieties"}</button
					>
				</form>
			{:else if step === "variety"}
				<h2>Add varieties and photos</h2>
				<p class="inline-help">
					Each color or design is a variety. Its photo appears on every relic in that variety,
					unless you give a relic its own photo.
				</p>
				<form inert={busy} onsubmit={createVariety}>
					<label class="field"
						><span>Relic type</span><select class="select" bind:value={typeId}
							>{#each catalog.types as type (type.id)}<option value={type.id}>{type.name}</option
								>{/each}</select
						></label
					>
					<label class="field"
						><span>Variety name</span><input
							class="input"
							required
							maxlength="80"
							bind:value={name}
							placeholder="For example, Moss green"
						/></label
					>
					<ImageUpload bind:url={image} bind:busy={uploading} />
					<details>
						<summary>Description (optional)</summary><label class="field"
							><span>Description</span><textarea
								class="textarea"
								maxlength="4000"
								bind:value={description}></textarea></label
						>
					</details>
					<button class="btn btn-primary" disabled={busy || uploading || !typeId}
						>{busy ? "Saving variety…" : "Save variety"}</button
					>
				</form>
				{#if varieties.length}<div class="saved-varieties rule">
						<h3>Saved for {catalog.types.find((t) => t.id === typeId)?.name}</h3>
						{#each varieties as variety (variety.id)}<div class="variety-row">
								{#if variety.imageUrl}<img src={variety.imageUrl} alt={variety.name} />{/if}<span
									>{variety.name}{#if !variety.imageUrl}<span class="muted">
											· No photo yet</span
										>{/if}</span
								>
							</div>{/each}<button
							class="btn btn-neutral"
							onclick={() => {
								step = "batch";
								added = "";
							}}>Continue to make tags</button
						>
					</div>{/if}
			{:else}
				<h2>Make tags: how many?</h2>
				<p class="inline-help">
					Create one unique link for each physical tag. Choose a variety and quantity. You will
					write the links to your tags in the next step.
				</p>
				<form inert={busy} onsubmit={batch}>
					<label class="field"
						><span>Relic type</span><select class="select" bind:value={typeId}
							>{#each catalog.types as type (type.id)}<option value={type.id}>{type.name}</option
								>{/each}</select
						></label
					>
					{#if varieties.length}
						<label class="field"
							><span>Variety</span><select class="select" bind:value={varietyId}
								>{#each varieties as variety (variety.id)}<option value={variety.id}
										>{variety.name}</option
									>{/each}</select
							></label
						>
						<label class="field"
							><span>How many tags?</span><input
								class="input"
								type="number"
								min="1"
								max="500"
								required
								bind:value={quantity}
							/></label
						>
						<details>
							<summary>Custom numbers and story (optional)</summary><label class="check-row"
								><input type="checkbox" bind:checked={manual} />Choose the first catalog number
								myself</label
							>{#if manual}<label class="field"
									><span>First catalog number</span><input
										class="input"
										type="number"
										min="0"
										max="65535"
										required
										bind:value={customStart}
									/></label
								>{/if}<label class="field"
								><span>Story for this batch (optional)</span><textarea
									class="textarea"
									maxlength="4000"
									bind:value={lore}></textarea></label
							>
						</details>
						<p class="message">
							{quantity} new tags for {catalog.varieties.find((v) => v.id === varietyId)?.name}.
							Catalog numbers {start} to {end}. Existing tags stay as they are.
						</p>
						{#if end > 65535}<p class="message error" role="alert">
								This variety has room for {65536 - start} more tags. Choose a smaller quantity.
							</p>{/if}
						<button class="btn btn-primary" disabled={busy || end > 65535}
							>{busy ? "Creating tags…" : "Make tags and open checklist"}</button
						>
					{:else}<p class="message">Add a variety for this type before making tags.</p>
						<button
							type="button"
							class="btn btn-primary"
							onclick={() => {
								begin("variety");
							}}>Add a variety</button
						>{/if}
				</form>
			{/if}
		</section>
		<aside class="setup-notes">
			<h3>Your next steps</h3>
			<ol class="route-list">
				<li aria-current={step === "type" ? "step" : undefined}>
					<strong>Name the type</strong><span>You only do this once for each kind of creature.</span
					>
				</li>
				<li aria-current={step === "variety" ? "step" : undefined}>
					<strong>Add varieties</strong><span>Add as many colors or designs as you need.</span>
				</li>
				<li aria-current={step === "batch" ? "step" : undefined}>
					<strong>Make tags</strong><span>A separate link for every physical tag.</span>
				</li>
				<li>
					<strong>Write and check off</strong><span
						>Progress is saved so you can come back later.</span
					>
				</li>
			</ol>
			<a href="/admin/catalog">Edit existing names and photos</a>
		</aside>
	</div>
{/if}

<style>
	.start-work,
	.setup-layout {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: 64px;
	}
	.start-work {
		margin-block: 16px 48px;
	}
	h2 {
		font-size: 1.75rem;
	}
	.start-work p {
		color: var(--muted);
		margin-block: 24px;
	}
	.route-list {
		padding-inline-start: 24px;
		margin: 0;
	}
	.route-list li {
		padding-inline-start: 8px;
		margin-block-end: 24px;
	}
	.route-list strong,
	.route-list span {
		display: block;
	}
	.route-list strong {
		font-weight: 500;
	}
	.route-list span {
		color: var(--muted);
		font-size: 0.875rem;
		margin-block-start: 8px;
	}
	[aria-current="step"] {
		color: var(--color-primary);
	}
	.setup-notes {
		background: var(--color-base-200);
		padding: 32px;
		align-self: start;
	}
	.setup-notes h3 {
		margin-block-end: 24px;
	}
	.existing {
		padding-block-start: 32px;
	}
	.type-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		padding-block: 24px;
		border-block-end: 1px solid var(--rule);
	}
	.type-row p {
		margin-block-start: 8px;
	}
	.saved-varieties {
		margin-block-start: 32px;
		padding-block-start: 24px;
	}
	.variety-row {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-block: 16px;
	}
	.variety-row img {
		width: 64px;
		height: 64px;
		object-fit: cover;
	}
	details {
		margin-block: 16px 24px;
	}
	.check-row {
		display: flex;
		gap: 16px;
		align-items: center;
		min-height: 48px;
	}
	@media (max-width: 800px) {
		.start-work,
		.setup-layout {
			grid-template-columns: minmax(0, 1fr);
			gap: 32px;
		}
		.setup-notes {
			padding: 24px;
		}
		.type-row {
			align-items: start;
			flex-direction: column;
		}
	}
</style>
