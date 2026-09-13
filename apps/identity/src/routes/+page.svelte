<script lang="ts">
	import { resolve } from "$app/paths";

	import type { PageData } from "./$types";

	const { data }: { data: PageData } = $props();

	let query = $state("");

	const people = $derived(
		data.state.people.filter((person) =>
			`${person.username} ${person.displayName} ${person.roleIds.join(" ")}`
				.toLowerCase()
				.includes(query.trim().toLowerCase()),
		),
	);

	const apps = $derived(
		data.state.resources.filter((resource) =>
			`${resource.name} ${resource.slug}`.toLowerCase().includes(query.trim().toLowerCase()),
		),
	);
</script>

<svelte:head><title>PetalNet Identity</title></svelte:head>

<main>
	<header>
		<h1>PetalNet Identity</h1>
		<p class="evidence">
			{#if data.state.error}
				<span class="bad">Could not read Authentik</span>
			{:else}
				{data.evidence.checks} checks, {data.evidence.ageSeconds}s ago{#if data.evidence.unknownCount},
					{data.evidence.unknownCount} unchecked{/if}
				{#if data.evidence.stale}<span class="bad">STALE</span>{/if}
				<a href="{resolve('/')}?refresh">re-run</a>
			{/if}
		</p>
	</header>

	{#if data.state.error}
		<section class="card alarm">
			<h2>Nothing below is current</h2>
			<p>{data.state.error}</p>
			<p class="dim">
				This is missing information, not a clean result. The page will not show a calm dashboard it
				cannot stand behind.
			</p>
		</section>
	{:else}
		{#if data.state.gate.blocked}
			<section class="card alarm">
				<h2>Creating a person is blocked</h2>
				<p>{data.state.gate.reason}</p>
				<p class="mono">{data.state.gate.unboundApplications.join("  ")}</p>
			</section>
		{:else}
			<section class="card ok">
				<h2>Safe to create people</h2>
				<p>Every application has an access policy.</p>
			</section>
		{/if}

		<input
			class="search"
			type="search"
			bind:value={query}
			placeholder="Search people and apps"
			aria-label="Search people and applications"
			autocapitalize="none"
			spellcheck="false"
		/>

		{#if data.state.findings.length}
			<h2 class="sectionTitle">
				Needs attention <span class="count">{data.state.findings.length}</span>
			</h2>
			<ul class="cards">
				{#each data.state.findings.slice(0, 8) as finding (finding.id)}
					<li class="card" class:alarm={finding.severity === "critical"}>
						<span class="kind">{finding.kind.replaceAll("_", " ")}</span>
						<strong>{finding.subject}</strong>
						<p>{finding.explanation}</p>
						<p class="dim small">{finding.evidence}</p>
					</li>
				{/each}
			</ul>
			{#if data.state.findings.length > 8}
				<p class="dim small">and {data.state.findings.length - 8} more</p>
			{/if}
		{/if}

		<h2 class="sectionTitle">People <span class="count">{people.length}</span></h2>
		<ul class="cards">
			{#each people as person (person.id)}
				<li>
					<a class="row" href={resolve("/p/[username]", { username: person.username })}>
						<span class="rowMain">
							<strong>{person.displayName}</strong>
							<span class="dim small">{person.roleIds.join(" · ") || "no roles"}</span>
						</span>
						<span class="reaches">{person.reaches}</span>
					</a>
				</li>
			{/each}
		</ul>

		<h2 class="sectionTitle">Applications <span class="count">{apps.length}</span></h2>
		<ul class="cards">
			{#each apps as resource (resource.slug)}
				<li class="row static" class:alarm={resource.unbound}>
					<span class="rowMain">
						<strong>{resource.name}</strong>
						<span class="dim small">
							{resource.unbound ? "open to every account" : resource.boundTo.join(", ")}
						</span>
					</span>
					<span class="reaches">{resource.reachedBy.length}</span>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	main {
		/* Phone first. The desktop case is this column centred, not a different layout. */
		max-width: 34rem;
		margin: 0 auto;
		padding: 1rem 1rem 5rem;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	header {
		border-bottom: 2px solid var(--ink);
		padding-bottom: 0.6rem;
	}
	h1 {
		margin: 0;
		font-size: 1.5rem;
		letter-spacing: -0.01em;
	}
	.evidence {
		margin: 0.2rem 0 0;
		font-size: 0.8rem;
		color: var(--ink-3);
	}
	.evidence a {
		color: var(--accent);
	}
	.bad {
		color: var(--danger);
		font-weight: 600;
	}
	.sectionTitle {
		margin: 0.75rem 0 0;
		font-size: 1rem;
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.count {
		font-family: var(--mono);
		font-size: 0.78rem;
		color: var(--ink-3);
	}
	.search {
		width: 100%;
		min-height: 3rem;
		padding: 0 0.85rem;
		font: inherit;
		background: var(--surface);
		color: var(--ink);
		border: 1px solid var(--rule);
		border-radius: 4px;
	}
	.search:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	ul.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--rule);
		border-radius: 4px;
		padding: 0.8rem 0.95rem;
	}
	.card h2 {
		margin: 0;
		font-size: 1rem;
	}
	.card p {
		margin: 0.25rem 0 0;
		font-size: 0.88rem;
	}
	.card.alarm {
		background: var(--danger-soft);
		border-color: var(--danger);
	}
	.card.ok {
		background: var(--ok-soft);
		border-color: var(--ok);
	}
	.kind {
		display: block;
		font-family: var(--mono);
		font-size: 0.68rem;
		letter-spacing: 0.06em;
		color: var(--danger);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		/* Thumb-sized rows: under ~44px is a mis-tap waiting to happen. */
		min-height: 3.25rem;
		padding: 0.5rem 0.95rem;
		background: var(--surface);
		border: 1px solid var(--rule);
		border-radius: 4px;
		color: inherit;
		text-decoration: none;
	}
	.row.static {
		cursor: default;
	}
	.row.alarm {
		background: var(--danger-soft);
		border-color: var(--danger);
	}
	.row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.rowMain {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.rowMain strong {
		font-weight: 600;
	}
	.rowMain span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.reaches {
		font-family: var(--mono);
		font-variant-numeric: tabular-nums;
		font-size: 0.9rem;
		color: var(--ink-3);
	}
	.dim {
		color: var(--ink-3);
	}
	.small {
		font-size: 0.8rem;
	}
	.mono {
		font-family: var(--mono);
		font-size: 0.8rem;
		word-break: break-word;
	}
</style>
