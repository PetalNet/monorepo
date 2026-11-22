<script lang="ts">
	import { refreshAll } from "$app/navigation";
	import { ArrowLeft, Check, Lock, Plus } from "@lucide/svelte";

	import { command } from "#lib/client.ts";
	import Mushroom from "#lib/components/Mushroom.svelte";
	let { data }: import("./$types").PageProps = $props();
	let relic = $derived(data.relic);
	let displayName = $derived(
		relic.name === `${relic.typeName} - ${relic.varietyName} #${String(relic.indexNumber)}`
			? relic.typeName
			: relic.name,
	);
	let claiming = $state(false),
		busy = $state(false),
		name = $state(""),
		message = $state(""),
		error = $state("");
	let releaseDialog: HTMLDialogElement;
	async function claim(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = "";

		try {
			await command("claim", { relicId: relic.id, name: data.collection.name ?? name });
			claiming = false;
			message = "A new addition to your collection.";
			await refreshAll();
		} catch (e) {
			error = e instanceof Error ? e.message : "Could not claim. Try again.";
		} finally {
			busy = false;
		}
	}
	async function release() {
		busy = true;
		error = "";

		try {
			await command("release", { relicId: relic.id });
			releaseDialog.close();
			message = "Released. The next person can claim it.";
			await refreshAll();
		} catch (e) {
			error = e instanceof Error ? e.message : "Could not release. Try again.";
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head
	><title>{relic.varietyName} {relic.typeName} · No. {relic.indexNumber} · Petal Relics</title
	></svelte:head
>
<a class="back-link" href="/collection"><ArrowLeft size={16} /> My collection</a>
<article class="specimen">
	<div class="specimen-art">
		{#if relic.imageUrl}<img
				src={relic.imageUrl}
				alt={`${relic.varietyName} ${relic.typeName} collectible`}
				fetchpriority="high"
			/>{:else}<Mushroom size={160} /><span>Artwork not yet added</span>{/if}
		<div class="photo-label"><span>{relic.typeName}</span><span>Physical specimen</span></div>
	</div>
	<div class="specimen-label">
		<div class="number mono">
			<span>No.</span><span>{String(relic.indexNumber ?? 0).padStart(3, "0")}</span>
		</div>
		<div class="identity">
			<h1>{displayName}</h1>
			<p class="variety">{relic.varietyName} variety</p>
		</div>
		<dl>
			<div class="label-row metadata">
				<dt>Type</dt>
				<dd>{relic.typeName}</dd>
			</div>
			<div class="label-row metadata">
				<dt>Variety</dt>
				<dd>{relic.varietyName}</dd>
			</div>
			<div class="label-row">
				<dt>Collection</dt>
				<dd>
					{#if relic.owned}Yours{:else if relic.claimed}Already claimed{:else}Not yet claimed{/if}
				</dd>
			</div>
		</dl>
		{#if relic.description}<p class="description">{relic.description}</p>{/if}{#if relic.lore}<p
				class="description muted"
			>
				{relic.lore}
			</p>{/if}
		<div class="ownership" aria-busy={busy}>
			{#if relic.owned}<div class="ownership-title">
					<Check size={20} /><span>In your collection</span>
				</div>
				<p class="muted small">A find to call your own.</p>
				<div class="actions">
					<a class="btn btn-primary" href="/collection">View my collection</a><button
						class="btn btn-ghost"
						onclick={() => {
							releaseDialog.showModal();
						}}>Release</button
					>
				</div>
			{:else if relic.claimed}<div class="ownership-title">
					<Lock size={18} /><span>Already claimed</span>
				</div>
				<p class="muted small">This relic has a home. Its owner can release it for someone new.</p>
				<a class="legacy-link" href="/legacy"
					>Is this one of your old relics? Move your collection</a
				>
			{:else if claiming}<form onsubmit={claim}>
					<label class="field"
						><span>Your name</span><input
							class="input"
							required
							maxlength="80"
							autocomplete="given-name"
							bind:value={name}
							placeholder="What should we call you?"
						/></label
					>
					<p class="muted small">
						Only you and admins can see your collection. It stays on this device.
					</p>
					<div class="actions">
						<button class="btn btn-primary" disabled={busy}
							>{busy ? "Claiming…" : "Claim relic"}</button
						><button
							type="button"
							class="btn btn-ghost"
							onclick={() => (claiming = false)}
							disabled={busy}>Cancel</button
						>
					</div>
				</form>
			{:else}<button
					class="btn btn-primary claim"
					disabled={busy}
					onclick={() => {
						if (data.collection.name) {
							void claim(new SubmitEvent("submit"));
						} else {
							claiming = true;
						}
					}}><Plus size={18} />Claim relic</button
				>
				<p class="muted small">Make it yours. No account needed.</p>{/if}
			{#if error}<p class="message error" role="alert">{error}</p>{/if}{#if message}<p
					class="message"
					role="status"
				>
					{message}
				</p>{/if}
		</div>
		<details class="catalog-detail">
			<summary class="muted small">Catalog record</summary><code>{relic.id}</code>
		</details>
	</div>
</article>
<dialog bind:this={releaseDialog} onclose={() => (error = "")}>
	<h2>Pass this relic on?</h2>
	<p>Releasing removes it from your collection. The next person who opens its tag can claim it.</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		<button class="btn btn-primary" disabled={busy} onclick={release}
			>{busy ? "Releasing…" : "Release relic"}</button
		><button
			class="btn btn-ghost"
			disabled={busy}
			onclick={() => {
				releaseDialog.close();
			}}>Keep it</button
		>
	</div>
</dialog>

<style>
	.specimen {
		display: grid;
		grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
		gap: 64px;
		align-items: start;
	}
	.specimen-art {
		position: relative;
		aspect-ratio: 1;
		background: var(--photo);
		overflow: hidden;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 24px;
		color: #505b4e;
	}
	.specimen-art > img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.photo-label {
		position: absolute;
		inset: auto 16px 16px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		font-size: 0.75rem;
		background: #f2f0e7;
		color: #202820;
		padding: 16px;
	}
	.number {
		display: flex;
		align-items: baseline;
		gap: 16px;
		font-variant-numeric: tabular-nums;
		color: var(--color-primary);
		line-height: 1;
	}
	.number > span:first-child {
		font-size: 1rem;
	}
	.number > span:last-child {
		font-size: 6rem;
		font-weight: 400;
	}
	.identity {
		margin-block: 32px 24px;
	}
	.identity h1 {
		font-size: clamp(2.5rem, 4vw, 3.5rem);
	}
	.variety {
		font-size: 1.25rem;
		color: var(--muted);
		margin-block-start: 8px;
	}
	dl {
		margin: 0;
	}
	.ownership {
		margin-block-start: 32px;
	}
	.ownership-title {
		display: flex;
		gap: 12px;
		align-items: center;
		color: var(--color-primary);
		font-size: 1.125rem;
		margin-block-end: 8px;
	}
	.ownership .actions {
		margin-block-start: 24px;
	}
	.claim {
		width: 100%;
		margin-block-end: 12px;
	}
	.claim + p {
		text-align: center;
	}
	.description {
		margin-block-start: 24px;
	}
	.legacy-link {
		display: block;
		font-size: 0.875rem;
		margin-block-start: 24px;
	}
	.catalog-detail {
		margin-block-start: 24px;
	}
	.catalog-detail summary {
		min-height: 32px;
	}
	.catalog-detail code {
		color: var(--muted);
	}
	@media (max-width: 1000px) {
		.specimen {
			gap: 40px;
			grid-template-columns: 1fr 1fr;
		}
		.number > span:last-child {
			font-size: 5rem;
		}
	}
	@media (max-width: 700px) {
		.metadata {
			display: none;
		}
		.specimen {
			grid-template-columns: 1fr;
			gap: 32px;
		}
		.specimen-art {
			max-height: 480px;
		}
		.specimen-label {
			position: relative;
		}
		.number {
			position: absolute;
			inset: 4px 0 auto auto;
			gap: 8px;
		}
		.number > span:last-child {
			font-size: 3rem;
		}
		.number > span:first-child {
			font-size: 0.875rem;
		}
		.identity {
			margin-block: 0 24px;
			padding-inline-end: 128px;
		}
		.identity h1 {
			font-size: 2rem;
		}
		.variety {
			font-size: 1rem;
		}
		.photo-label {
			inset: auto 12px 12px;
			padding: 12px;
			font-size: 0.75rem;
		}
		.ownership {
			margin-block-start: 24px;
		}
		.back-link {
			margin-block-end: 16px;
		}
	}
</style>
