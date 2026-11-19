<script>
	import { ago } from "#lib/ago.js";
	import { galleryHref } from "#lib/gallery-tree.js";
	import Icon from "#lib/Icon.svelte";

	/**
	 * @type {{
	 * 	ongoing: import("#lib/server/gallery/schema.ts").Ongoing;
	 * 	project?: string;
	 * 	work?: string;
	 * 	show?: "all";
	 * 	peek?: number;
	 * }}
	 */
	// Without `peek` this is the whole list under the page's own "Ongoing" heading.
	let { ongoing, project = "", work = "", show, peek } = $props();

	const CHECKS = {
		failing: { icon: "failing", text: "Checks failing" },
		running: { icon: "running", text: "Checks running" },
		passing: { icon: "passing", text: "Checks passing" },
		none: { icon: "nochecks", text: "No checks" },
	};
	const REVIEW = {
		draft: "Draft",
		changes: "Changes requested",
		approved: "Approved",
		requested: "Review requested",
		none: "",
	};

	const shown = $derived(ongoing.pulls.slice(0, peek));
	const hidden = $derived(ongoing.pulls.length - shown.length);
</script>

{#if ongoing.pulls.length || ongoing.more || ongoing.answers.length || ongoing.github === "unavailable"}
	<section class="block" aria-label="Ongoing">
		{#if peek && (shown.length || ongoing.answers.length || ongoing.github === "unavailable")}
			<h2>Ongoing</h2>
		{/if}
		{#if ongoing.github === "unavailable"}
			<p class="note" role="status">GitHub did not answer, so pull requests are missing here.</p>
		{/if}
		{#if shown.length || ongoing.answers.length}
			<ul class="rows">
				{#each ongoing.answers as a (a.slug)}
					<li class="row">
						<span class="state answers" title="Unresolved answers"
							><Icon name="comment" size={16} /></span
						>
						<span class="body">
							<a class="title" href="/gallery/{a.slug}">{a.title}</a>
							<span class="meta mono">
								<span class="strong"
									>{a.count} unresolved {a.count === 1 ? "answer" : "answers"}</span
								>
								<span>{ago(a.latest)}</span>
							</span>
						</span>
					</li>
				{/each}
				{#each shown as p (p.url)}
					<li class="row">
						<span class="state {p.ci}" title={CHECKS[p.ci].text}
							><Icon name={CHECKS[p.ci].icon} size={16} /></span
						>
						<span class="body">
							<a class="title" href={p.url} target="_blank" rel="noopener noreferrer">{p.title}</a>
							<span class="meta mono">
								<span>{p.label}</span>
								{#if p.ci === "failing" || p.ci === "running"}
									<span class="strong">{CHECKS[p.ci].text}</span>
								{:else}
									<span class="sr">{CHECKS[p.ci].text}</span>
								{/if}
								{#if REVIEW[p.review]}<span class:strong={p.review === "changes"}
										>{REVIEW[p.review]}</span
									>{/if}
								<span>{p.author}</span>
								<span>{ago(p.updatedAt)}</span>
								{#if p.pages}
									<a class="pages" href={galleryHref({ link: p.label })}
										>{p.pages} {p.pages === 1 ? "page" : "pages"}</a
									>
								{/if}
							</span>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
		{#if hidden > 0}
			<a class="all" href={galleryHref({ project, work, show, view: "ongoing" })}
				>All {ongoing.pulls.length} open pull requests</a
			>
		{/if}
		{#if ongoing.more}
			<a class="all" href={galleryHref({ show: "all", view: "ongoing" })}
				>{ongoing.more}
				{shown.length ? "more" : ongoing.more === 1 ? "open pull request" : "open pull requests"} outside
				your projects</a
			>
		{/if}
	</section>
{/if}

<style>
	.block {
		margin-block-start: 28px;
	}
	h2 {
		margin-block-end: 10px;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-3);
	}
	/* one filled surface; rows are separated by hairline rules, not borders around each */
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		background: var(--surface-2);
		border-radius: var(--radius);
	}
	.row {
		position: relative;
		display: flex;
		gap: 12px;
		padding: 12px 16px;
	}
	.row + .row {
		border-block-start: 1px solid var(--border);
	}
	.state {
		flex: none;
		display: grid;
		place-items: center;
		align-self: flex-start;
		block-size: 20px;
		color: var(--text-4);
	}
	.state.failing {
		color: var(--danger-b);
	}
	.state.running {
		color: var(--warn-b);
	}
	.state.passing {
		color: var(--violet-b);
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-inline-size: 0;
	}
	.title {
		font-size: 14px;
		line-height: 20px;
		color: var(--text-1);
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.title:hover,
	.pages:hover,
	.all:hover {
		color: var(--accent-b);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		font-size: 12px;
		color: var(--text-3);
	}
	.strong {
		color: var(--text-1);
	}
	.pages {
		color: var(--accent-b);
		text-decoration: none;
	}
	.sr {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.note {
		margin-block-end: 10px;
		font-size: 13px;
		color: var(--text-3);
	}
	.all {
		display: inline-block;
		margin-block-start: 10px;
		margin-inline-end: 16px;
		font-size: 13px;
		color: var(--text-3);
		text-decoration: none;
	}
</style>
