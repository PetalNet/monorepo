<script lang="ts">
	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import type { PageData } from "../../routes/admin/[...path]/$types";
	import type { AdminCommand } from "../schema";
	import RelicPhoto from "./RelicPhoto.svelte";
	import UploadField from "./UploadField.svelte";

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
			added = "Type saved. Let’s add its first color or design.";
		}
	}
	async function createVariety(event: SubmitEvent) {
		event.preventDefault();
		const submittedName = name.trim();

		if (await save({ kind: "variety", typeId, name, description, imageUrl: image })) {
			added = `${name} saved. Add another, or make its tags.`;

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
			<h2>A little friend starts here.</h2>
			<p>
				Name the type, add its colors and photos, then make and write its tags. We’ll take it one
				step at a time.
			</p>
			<button
				class="btn btn-primary"
				onclick={() => {
					begin("type");
				}}>Add a new relic type</button
			>
		</div>
		<a class="resume-link" href="/admin/nfc-writer">Pick up where you left off: write tags</a>
	</section>
	<section class="rule existing">
		<h2>Already have a type?</h2>
		{#each catalog.types as type (type.id)}
			<div class="type-row">
				<div>
					<h3>{type.name}</h3>
					<p class="muted">
						{catalog.varieties.filter((v) => v.typeId === type.id).length} colors / designs · {catalog.relics.filter(
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
						}}>Add a color or design</button
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
			<p class="step-progress">
				Step {step === "type" ? 1 : step === "variety" ? 2 : 3} of 4 · {step === "type"
					? "Name the type"
					: step === "variety"
						? "Colors and photos"
						: "Make tags"}
			</p>
			{#if step === "type"}
				<h2>Add a new relic type</h2>
				<p class="inline-help">
					What kind of little friend is it? Snail, mushroom, something else?
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
						><UploadField bind:url={image} bind:busy={uploading} />
					</details>
					<button class="btn btn-primary" disabled={busy || uploading}
						>{busy ? "Saving type…" : "Save and add colors"}</button
					>
				</form>
			{:else if step === "variety"}
				<h2>Add a color or design</h2>
				<p class="inline-help">
					Give each color or design a name and photo. That photo will appear on its tags.
				</p>
				<form inert={busy} onsubmit={createVariety}>
					<label class="field"
						><span>Relic type</span><select class="select" bind:value={typeId}
							>{#each catalog.types as type (type.id)}<option value={type.id}>{type.name}</option
								>{/each}</select
						></label
					>
					<label class="field"
						><span>Color or design name</span><input
							class="input"
							required
							maxlength="80"
							bind:value={name}
							placeholder="For example, Moss green"
						/></label
					>
					<UploadField bind:url={image} bind:busy={uploading} />
					<details>
						<summary>Description (optional)</summary><label class="field"
							><span>Description</span><textarea
								class="textarea"
								maxlength="4000"
								bind:value={description}></textarea></label
						>
					</details>
					<button class="btn btn-primary" disabled={busy || uploading || !typeId}
						>{busy ? "Saving…" : "Save color or design"}</button
					>
				</form>
				{#if varieties.length}<div class="saved-varieties rule">
						<h3>Saved for {catalog.types.find((t) => t.id === typeId)?.name}</h3>
						{#each varieties as variety (variety.id)}<div class="variety-row">
								<div class="variety-photo">
									<RelicPhoto src={variety.imageUrl} alt={variety.name} />
								</div>
								<span
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
				<h2>How many tags?</h2>
				<p class="inline-help">
					One link for each physical tag. Next, we’ll write them to your tags.
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
							><span>Color or design</span><select class="select" bind:value={varietyId}
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
							>{busy ? "Creating tags…" : "Make tags and start writing"}</button
						>
					{:else}<p class="message">Add a color or design for this type first.</p>
						<button
							type="button"
							class="btn btn-primary"
							onclick={() => {
								begin("variety");
							}}>Add a color or design</button
						>{/if}
				</form>
			{/if}
		</section>
	</div>
{/if}

<style>
	.start-work,
	.setup-layout {
		max-width: 560px;
	}
	.start-work {
		margin-block: 8px 40px;
	}
	h2 {
		font: 500 1.75rem/1.2 var(--font-display, Lora, serif);
	}
	.start-work p {
		color: var(--muted);
		margin-block: 16px 24px;
	}
	.resume-link {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		margin-top: 8px;
		color: var(--muted);
		font-size: 0.9375rem;
	}
	.step-progress {
		color: var(--muted);
		font-size: 0.875rem;
		margin-bottom: 12px;
	}
	.back-link {
		margin-bottom: 16px;
	}
	.inline-help {
		margin-block: 12px 24px;
		font-size: 1rem;
	}
	form {
		min-width: 0;
	}
	select {
		min-width: 0;
	}
	.btn {
		border-radius: 8px;
		min-height: 52px;
		white-space: normal;
		font-weight: 700;
	}
	form > .btn {
		width: 100%;
		margin-top: 8px;
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
	.variety-photo {
		width: 64px;
		height: 64px;
		flex: 0 0 64px;
		border-radius: 6px;
		overflow: hidden;
	}
	.variety-photo :global(.placeholder span) {
		display: none;
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
		.type-row {
			align-items: start;
			flex-direction: column;
		}
	}
	@media (max-width: 540px) {
		.start-work > div > .btn {
			width: 100%;
		}
		.type-row .actions {
			width: 100%;
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			gap: 8px;
		}
		.saved-varieties > .btn {
			width: 100%;
		}
	}
</style>
