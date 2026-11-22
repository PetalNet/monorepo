<script lang="ts">
	import SpecimenCard from "#lib/components/SpecimenCard.svelte";
	let { data }: import("./$types").PageProps = $props();
	let featured = $derived(data.collection.varieties.at(0));
</script>

<svelte:head
	><title>Petal Relics · A place for your finds</title><meta
		name="description"
		content="Tap a physical Petal Relic, claim it, and keep a collection of your own."
	/></svelte:head
>
{#if data.collection.relics.length}
	<div class="page-heading">
		<div>
			<h1>Good to have you here,<br />{data.collection.name}.</h1>
			<p>Your finds, kept together.</p>
		</div>
		<a class="btn btn-primary" href="/collection">Open my collection</a>
	</div>
	<div class="specimen-grid">
		{#each data.collection.relics.slice(0, 3) as relic (relic.id)}<SpecimenCard {relic} />{/each}
	</div>
{:else}
	<section class="empty-intro">
		<div>
			<h1>Small finds.<br />Yours to keep.</h1>
			<p>A little creature. A tag. A collection that grows one find at a time.</p>
			<p>Tap the NFC tag or scan the QR code on your relic to meet it and make it yours.</p>
			<div class="actions">
				<a class="btn btn-primary" href="/collection">My collection</a><a
					class="btn btn-ghost"
					href="/restore">Restore a collection</a
				>
			</div>
		</div>
		<div class="art">
			{#if featured?.imageUrl}<img
					src={featured.imageUrl}
					alt={`A physical ${featured.name} ${featured.typeName} collectible`}
				/>
				<div class="art-caption">
					<span>{featured.typeName}</span><span>{featured.name} variety</span>
				</div>{:else}<div class="message">The next specimen is on its way.</div>{/if}
		</div>
	</section>
	<div class="home-note rule">
		<div>
			<h2>A collection of your own.</h2>
			<p class="muted">
				Your collection stays on this device. Add a recovery email after your first claim to bring
				it along when you change phones.
			</p>
		</div>
		<a href="/legacy">Collected here before? Move your relics</a>
	</div>
{/if}

<style>
	.home-note {
		padding-block-start: 32px;
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 40px;
	}
	.home-note h2 {
		font-size: 1.25rem;
		margin-block-end: 12px;
	}
	.home-note p {
		font-size: 0.875rem;
		max-width: 54ch;
	}
	.home-note > a {
		font-size: 0.875rem;
		min-height: 44px;
		display: flex;
		align-items: center;
	}
	@media (max-width: 700px) {
		.home-note {
			flex-direction: column;
			gap: 16px;
		}
	}
</style>
