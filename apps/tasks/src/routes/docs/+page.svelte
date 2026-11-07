<script>
	import Icon from "$lib/Icon.svelte";
	let { data } = $props();
	function ago(ts) {
		if (!ts) {
			return "";
		}

		const s = Math.round((Date.now() - new Date(ts.replace(" ", "T") + "Z").getTime()) / 1000);

		if (s < 60) {
			return "just now";
		}

		if (s < 3600) {
			return Math.round(s / 60) + "m ago";
		}

		if (s < 86400) {
			return Math.round(s / 3600) + "h ago";
		}

		if (s < 604800) {
			return Math.round(s / 86400) + "d ago";
		}

		return Math.round(s / 604800) + "w ago";
	}
</script>

<svelte:head><title>docs · tasks</title></svelte:head>

<div class="screen docs">
	<header class="page-head">
		<h1>docs</h1>
		<p class="ph-sub mono">{data.total} research docs, briefs &amp; ADRs · grouped by project</p>
	</header>

	{#if data.total > data.pageSize}
		{@const firstIdx = data.page * data.pageSize + 1}
		{@const lastIdx = data.page * data.pageSize + data.shown}
		<nav class="docs-pager mono" aria-label="doc pages">
			{#if data.page > 0}<a class="pg" href="?page={data.page - 1}">← newer</a>{:else}<span
					class="pg dis">← newer</span
				>{/if}
			<span class="pg-range">{firstIdx}–{lastIdx} of {data.total}</span>
			{#if data.hasMore}<a class="pg" href="?page={data.page + 1}">older →</a>{:else}<span
					class="pg dis">older →</span
				>{/if}
		</nav>
	{/if}

	{#if data.groups.length}
		<div class="lanes">
			{#each data.groups as g (g.project)}
				<section class="lane">
					<div class="lane-head">
						<span class="lane-ic"><Icon name="doc" size={14} /></span>
						<!-- task-332: lane heads are ALWAYS a real h2 (stable heading outline);
                 the project link nests inside instead of replacing the heading -->
						<h2>
							{#if g.project_id}<a
									class="proj-link mono"
									href="/?project={encodeURIComponent(g.project)}">{g.project}</a
								>{:else}{g.project}{/if}
						</h2>
						<span class="lane-count">{g.docs.length}</span>
					</div>
					<div class="lane-body">
						{#each g.docs as d (d.id)}
							<a class="row kind-doc st-todo" href="/task/{d.id}">
								<span class="row-ic"><Icon name="doc" size={16} /></span>
								<span class="row-main"><span class="row-title">{d.title}</span></span>
								<span class="row-right">
									{#if d.created_by}<span class="mono dim">{d.created_by}</span>{/if}
									<span class="mono dim age">{ago(d.updated_at)}</span>
								</span>
							</a>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{:else}
		<p class="empty">No docs yet.</p>
	{/if}
</div>

<style>
	.lane-head h2 {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-3);
	}
	.proj-link {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text-2);
		text-decoration: none;
		text-transform: lowercase;
		letter-spacing: 0;
	}
	.proj-link:hover {
		color: var(--accent-b);
	}
	.row-right {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.empty {
		color: var(--text-4);
		font-size: 13px;
	}
	.docs-pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		padding: 4px 0 16px;
		font-size: 12px;
	}
	.docs-pager .pg {
		text-decoration: none;
		color: var(--text-2);
		padding: 4px 10px;
		border: 1px solid var(--line, var(--text-4));
		border-radius: 6px;
	}
	.docs-pager .pg:hover {
		color: var(--accent-b);
	}
	.docs-pager .pg.dis {
		color: var(--text-4);
		border-color: transparent;
		pointer-events: none;
	}
	.docs-pager .pg-range {
		color: var(--text-3);
	}
</style>
