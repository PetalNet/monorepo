<script>
	import ArtifactCard from "#lib/ArtifactCard.svelte";
	import { galleryHref, UNFILED } from "#lib/gallery-tree.js";
	import Icon from "#lib/Icon.svelte";
	import Ongoing from "#lib/Ongoing.svelte";

	let { data } = $props();

	// How many pages one project shows when you are looking at every project; the rest is one click in.
	const PEEK = 4;
	// How many pull requests the index shows above its pages; ?view=ongoing shows them all.
	const ONGOING_PEEK = 5;

	const name = (/** @type {string} */ project) => (project === UNFILED ? "unfiled" : project);
	const asks = $derived(data.artifacts.filter((a) => a.asked));
	const rest = $derived(data.artifacts.filter((a) => !a.asked));

	// project > piece of work > artifact, in the order the server returned (newest first)
	const projects = $derived.by(() => {
		const byProject = Map.groupBy(rest, (a) => a.collection || UNFILED);

		return [...byProject]
			.toSorted(([x], [y]) => (x === UNFILED) - (y === UNFILED) || x.localeCompare(y))
			.map(([key, artifacts]) => ({ key, artifacts }));
	});
	const works = $derived.by(() => {
		const byWork = Map.groupBy(rest, (a) => a.work);

		return [...byWork]
			.toSorted(([x], [y]) => (x === "") - (y === ""))
			.map(([label, artifacts]) => ({ label, artifacts }));
	});
	const scope = $derived(data.work || (data.project ? name(data.project) : "All projects"));
	const title = $derived(data.view === "ongoing" ? "Ongoing" : scope);
</script>

<svelte:head><title>{title} · gallery</title></svelte:head>

<div class="screen gallery">
	<header class="head">
		<h1>{title}</h1>
		{#if data.workUrl}
			<a class="out mono" href={data.workUrl} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
		{/if}
		<form class="find" method="get" role="search">
			{#if data.project}<input type="hidden" name="project" value={data.project} />{/if}
			{#if data.work}<input type="hidden" name="work" value={data.work} />{/if}
			<!-- a search leaves the ongoing view: it finds pages -->
			<Icon name="search" size={15} />
			<input
				name="link"
				value={data.link}
				placeholder="Find by PR or issue: owner/repo#12"
				aria-label="Find pages by GitHub link"
			/>
			{#if data.link}
				<a
					class="clear"
					href={galleryHref({ project: data.project, work: data.work })}
					aria-label="Clear search"><Icon name="close" size={14} /></a
				>
			{/if}
		</form>
	</header>

	{#if asks.length}
		<section class="block" aria-label="Waiting on you">
			<h2>Waiting on you</h2>
			<div class="cards">
				{#each asks as a (a.slug)}<ArtifactCard {a} />{/each}
			</div>
		</section>
	{:else if !data.project && !data.link}
		<p class="caught">All caught up.</p>
	{/if}

	{#if data.ongoing}
		<Ongoing
			ongoing={data.ongoing}
			project={data.project}
			work={data.work}
			peek={data.view === "ongoing" ? undefined : ONGOING_PEEK}
		/>
	{/if}

	{#if data.view === "ongoing"}
		{#if !asks.length && !data.ongoing?.pulls.length && !data.ongoing?.answers.length}
			<p class="empty">Nothing in motion.</p>
		{/if}
	{:else if !rest.length && !asks.length}
		<p class="empty">{data.link ? "Nothing links there." : "No artifacts yet."}</p>
	{:else if data.work}
		<div class="cards">
			{#each rest as a (a.slug)}<ArtifactCard {a} />{/each}
		</div>
	{:else if data.project}
		{#each works as w (w.label)}
			<section class="block">
				{#if w.label}
					<h2>
						<a href={galleryHref({ project: data.project, work: w.label })}>{w.label}</a>
					</h2>
				{:else if works.length > 1}
					<h2>Other</h2>
				{/if}
				<div class="cards">
					{#each w.artifacts as a (a.slug)}<ArtifactCard {a} />{/each}
				</div>
			</section>
		{/each}
	{:else}
		{#each projects as p (p.key)}
			<section class="block">
				<h2><a href={galleryHref({ project: p.key })}>{name(p.key)}</a></h2>
				<div class="cards">
					{#each p.artifacts.slice(0, PEEK) as a (a.slug)}<ArtifactCard {a} />{/each}
				</div>
				{#if p.artifacts.length > PEEK}
					<a class="more" href={galleryHref({ project: p.key })}
						>{p.artifacts.length - PEEK} more in {name(p.key)}</a
					>
				{/if}
			</section>
		{/each}
	{/if}
</div>

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px 16px;
		margin-bottom: 8px;
	}
	h1 {
		font-size: clamp(24px, 4vw, 30px);
		font-weight: 700;
		letter-spacing: -0.025em;
		line-height: 1.15;
		margin-inline-end: auto;
		overflow-wrap: anywhere;
	}
	.out {
		font-size: 12px;
		color: var(--accent-b);
		text-decoration: none;
	}
	.find {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		max-width: 340px;
		padding: 0 10px;
		height: 40px;
		background: var(--surface-2);
		border-radius: var(--radius);
		color: var(--text-4);
	}
	.find input {
		flex: 1;
		min-width: 0;
		height: 100%;
		font: inherit;
		font-size: 13px;
		color: var(--text-1);
		background: none;
		border: 0;
		outline: none;
	}
	.find:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.clear {
		display: grid;
		place-items: center;
		color: var(--text-3);
	}
	.block {
		margin-top: 28px;
	}
	h2 {
		margin-bottom: 10px;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-3);
	}
	h2 a {
		color: inherit;
		text-decoration: none;
	}
	h2 a:hover,
	.more:hover {
		color: var(--accent-b);
	}
	.cards {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.block + .cards {
		margin-top: 28px;
	}
	.more {
		display: inline-block;
		margin-top: 10px;
		font-size: 13px;
		color: var(--text-3);
		text-decoration: none;
	}
	.caught,
	.empty {
		margin-top: 24px;
		color: var(--text-4);
		font-size: 13px;
	}
</style>
