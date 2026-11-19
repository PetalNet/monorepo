<script>
	import { ago } from "#lib/ago.js";
	import Icon from "#lib/Icon.svelte";

	/**
	 * @type {{
	 * 	a: {
	 * 		slug: string;
	 * 		title: string;
	 * 		description: string;
	 * 		visibility: string;
	 * 		updated_at: string;
	 * 		links: { url: string; label: string }[];
	 * 		asked?: boolean;
	 * 	};
	 * }}
	 */
	let { a } = $props();
</script>

<a class="card" class:asked={a.asked} href="/gallery/{a.slug}">
	<span class="title">{a.title}</span>
	{#if a.description}<span class="desc">{a.description}</span>{/if}
	<span class="meta mono">
		{#if a.asked}<span class="ask">Waiting on you</span>{/if}
		{#if a.visibility === "private"}<span class="priv" title="Only you can see this"
				><Icon name="lock" size={11} /> private</span
			>{/if}
		<span class="age">{ago(a.updated_at)}</span>
		{#each a.links as l (l.url)}<span class="gh" title={l.url}>{l.label}</span>{/each}
	</span>
</a>

<style>
	/* filled card: separated from the page by its surface, not a border */
	.card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 16px;
		background: var(--surface-2);
		border-radius: var(--radius);
		text-decoration: none;
		transition: background 0.12s;
	}
	.card:hover {
		background: var(--surface-3);
	}
	.title {
		font-size: 15px;
		font-weight: 600;
		color: var(--text-1);
	}
	.desc {
		font-size: 13px;
		line-height: 1.45;
		color: var(--text-3);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		margin-top: 4px;
		font-size: 11px;
	}
	.age,
	.priv {
		color: var(--text-4);
	}
	.priv {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.gh {
		color: var(--accent-b);
	}
	/* a page waiting on this viewer is tinted and says what it needs, instead of carrying a type label */
	.card.asked {
		background: var(--accent-bg);
	}
	.card.asked:hover {
		background: var(--accent-ln);
	}
	.ask {
		color: var(--text-1);
		font-weight: 600;
	}
</style>
