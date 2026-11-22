<script lang="ts">
	import { Mail, Check } from "@lucide/svelte";

	import { command } from "#lib/client.ts";
	import Mushroom from "#lib/components/Mushroom.svelte";
	import SpecimenCard from "#lib/components/SpecimenCard.svelte";
	let { data }: import("./$types").PageProps = $props();
	let collection = $derived(data.collection);
	let email = $state(""),
		busy = $state(false),
		message = $state(""),
		error = $state("");
	let selected = $state("all");
	let varieties = $derived(
		selected === "all"
			? collection.varieties
			: collection.varieties.filter((v) =>
					collection.sets.find((s) => String(s.id) === selected)?.varietyIds.includes(v.id),
				),
	);
	async function saveEmail(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = "";
		error = "";

		try {
			await command("email", { email });
			message = "Check your inbox. Open the link to verify your recovery email.";
		} catch (e) {
			error = e instanceof Error ? e.message : "Could not send. Try again.";
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>My collection · Petal Relics</title></svelte:head>
<div class="page-heading">
	<div>
		<h1>My collection<span class="collection-count">{collection.relics.length}</span></h1>
		<p>
			{collection.name
				? `${collection.name}’s private collection. Kept on this device.`
				: "Your own little corner of the cabinet."}
		</p>
	</div>
	{#if collection.relics.length}<a class="quiet-link" href="#recovery"
			><Mail size={16} />{collection.email ? "Recovery email" : "Keep your collection safe"}</a
		>{:else}<a class="quiet-link" href="/restore">Restore a collection</a>{/if}
</div>
{#if !collection.relics.length}<div class="collection-empty rule">
		<Mushroom size={40} />
		<div>
			<h2>Your first find belongs here.</h2>
			<p class="muted">
				Tap a relic’s NFC tag or scan its QR code, then claim it. The varieties below are waiting to
				join you.
			</p>
			<a href="/legacy">Already owned relics with a name and PIN?</a>
		</div>
	</div>{/if}
{#if collection.sets.length}<label class="field" style="max-width:320px"
		><span>Show set</span><select class="select" bind:value={selected}
			><option value="all">All varieties</option>{#each collection.sets as set (set.id)}<option
					value={String(set.id)}>{set.name}</option
				>{/each}</select
		></label
	>{/if}
{#each [...new Set(varieties.map((v) => v.typeId))] as typeId (typeId)}
	{@const group = varieties.filter((v) => v.typeId === typeId)}
	<section>
		<div class="section-heading">
			<h2>{group[0]?.typeName}</h2>
			<span class="muted mono"
				>{group.filter((v) => collection.relics.some((r) => r.varietyId === v.id)).length} of {group.length}
				varieties</span
			>
		</div>
		<div class="specimen-grid">
			{#each group as variety (variety.id)}{@const owned = collection.relics.filter(
					(r) => r.varietyId === variety.id,
				)}{#if owned.length}{#each owned as relic (relic.id)}<SpecimenCard
							{relic}
						/>{/each}{:else}<article class="specimen-card missing-card">
						<div class="photo" aria-hidden="true"><Mushroom size={120} /></div>
						<div class="caption">
							<div class="small"><span>{variety.typeName}</span><span>Not collected</span></div>
							<h3>{variety.name}</h3>
						</div>
					</article>{/if}{/each}
		</div>
	</section>
{/each}
{#if collection.relics.some((r) => r.varietyId === null)}<div class="section-heading">
		<h2>Other finds</h2>
	</div>
	<div class="specimen-grid">
		{#each collection.relics.filter((r) => r.varietyId === null) as relic (relic.id)}<SpecimenCard
				{relic}
			/>{/each}
	</div>{/if}
{#if collection.name}<section id="recovery" class="recovery rule">
		<div>
			<h2>Bring your collection along.</h2>
			<p class="muted">
				Your collection lives on this device. A verified email lets you restore it on another one.
				Without it, clearing browser data means asking an admin for help.
			</p>
			{#if collection.email}<p class="verified">
					<Check size={16} />Recovery email: {collection.email}
				</p>{/if}
		</div>
		<form onsubmit={saveEmail}>
			<label class="field"
				><span>{collection.email ? "Change recovery email" : "Recovery email (optional)"}</span
				><input
					class="input"
					type="email"
					autocomplete="email"
					required
					maxlength="254"
					bind:value={email}
					placeholder="you@example.com"
				/></label
			><button class="btn btn-primary" disabled={busy}
				>{busy ? "Sending…" : "Send verification link"}</button
			>{#if message}<p class="message" role="status">{message}</p>{/if}{#if error}<p
					class="message error"
					role="alert"
				>
					{error}
				</p>{/if}
		</form>
	</section>{/if}
<div class="collection-links rule">
	<a href="/legacy">Move a legacy collection</a><a href="/restore">Restore by email</a>
</div>

<style>
	.collection-count {
		font-size: 1.5rem;
		margin-inline-start: 16px;
		color: var(--color-primary);
		font-variant-numeric: tabular-nums;
		vertical-align: top;
	}
	.quiet-link {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 48px;
		font-size: 0.875rem;
	}
	.collection-empty {
		display: flex;
		gap: 24px;
		padding-block: 32px 8px;
		align-items: start;
	}
	.collection-empty > :global(span) {
		color: var(--color-primary);
		flex-shrink: 0;
	}
	.collection-empty h2 {
		font-size: 1.5rem;
		margin-block-end: 12px;
	}
	.collection-empty p {
		max-width: 62ch;
	}
	.collection-empty a {
		display: inline-block;
		margin-block-start: 16px;
		font-size: 0.875rem;
		min-height: 44px;
	}
	.recovery {
		margin-block-start: 64px;
		padding-block-start: 32px;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 64px;
	}
	.recovery h2 {
		margin-block-end: 16px;
		font-size: 1.5rem;
	}
	.recovery p {
		font-size: 0.875rem;
	}
	.recovery .field {
		margin-block-start: 0;
	}
	.verified {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-block-start: 24px;
		color: var(--color-primary);
		overflow-wrap: anywhere;
	}
	.collection-links {
		display: flex;
		gap: 32px;
		margin-block-start: 48px;
		padding-block-start: 24px;
		font-size: 0.875rem;
	}
	.collection-links a {
		min-height: 44px;
		display: flex;
		align-items: center;
	}
	@media (max-width: 650px) {
		.recovery {
			grid-template-columns: 1fr;
			gap: 24px;
		}
		.collection-empty {
			gap: 16px;
		}
		.collection-empty > :global(span) {
			width: 24px;
		}
		.collection-empty h2 {
			font-size: 1.25rem;
		}
		.collection-empty p {
			font-size: 0.875rem;
		}
		.collection-links {
			gap: 16px;
			justify-content: space-between;
		}
	}
</style>
