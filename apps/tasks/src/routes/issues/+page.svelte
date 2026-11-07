<script>
	import Icon from "$lib/Icon.svelte";
	import { projectName, whoColor } from "$lib/people.js";
	let { data } = $props();

	// whoColor single-sourced from $lib/people (this page's falsy fallback is the default 'var(--text-3)').
	const AGENTS = Object.entries(data.config?.people ?? {})
		.filter(([, person]) => person.kind === "agent")
		.map(([handle]) => handle);
	const isAgent = (h) => AGENTS.includes(String(h).toLowerCase());
	const projName = $derived(projectName(data.projects));

	function relShort(ts) {
		if (!ts) {
			return "";
		}

		const s = Math.round((Date.now() - new Date(ts.replace(" ", "T") + "Z").getTime()) / 1000);

		if (s < 60) {
			return s + "s";
		}

		if (s < 3600) {
			return Math.round(s / 60) + "m";
		}

		if (s < 86400) {
			return Math.round(s / 3600) + "h";
		}

		if (s < 604800) {
			return Math.round(s / 86400) + "d";
		}

		return Math.round(s / 604800) + "w";
	}
	const labelHue = (t) =>
		Math.abs([...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % 360;

	// Server-paginated (task-317): the list, tab, and page all come from the loader; tab switches
	// and prev/next are plain links that re-query one bounded page (no full-history payload).
	const tabHref = (t) => `?tab=${t}`;
	const pageHref = (p) => `?tab=${data.tab}&page=${p}`;
	const firstIdx = $derived(data.page * data.pageSize + 1);
	const lastIdx = $derived(data.page * data.pageSize + data.rows.length);
</script>

<svelte:head><title>issues · tasks</title></svelte:head>

{#snippet avatar(handle, size)}
	{@const c = whoColor(handle)}
	{@const ag = isAgent(handle)}
	<span
		class="avatar"
		style="width:{size}px;height:{size}px;font-size:{Math.round(
			size * 0.42,
		)}px;color:{c};border-color:{c};background:{ag ? 'transparent' : c + '22'};border-style:{ag
			? 'dashed'
			: 'solid'}">{(handle || "?").charAt(0).toLowerCase()}</span
	>
{/snippet}

<div class="screen issues">
	<header class="page-head">
		<h1>issues</h1>
		<p class="ph-sub mono">
			{data.openCount} open · {data.closedCount} closed · {data.projectCount} projects
		</p>
	</header>

	<div class="iss-list">
		<div class="iss-tabs">
			<a
				class="iss-tab"
				class:on={data.tab === "open"}
				aria-current={data.tab === "open" ? "page" : undefined}
				href={tabHref("open")}><Icon name="iopen" size={15} /> {data.openCount} Open</a
			>
			<a
				class="iss-tab"
				class:on={data.tab === "closed"}
				aria-current={data.tab === "closed" ? "page" : undefined}
				href={tabHref("closed")}><Icon name="iclosed" size={15} /> {data.closedCount} Closed</a
			>
		</div>

		{#each data.rows as it (it.id)}
			{@const closed = it.status === "done" || it.status === "dropped"}
			{@const author = it.created_by || it.responsible || it.assignee}
			<a class="iss-row" href="/task/{it.id}">
				<span class="iss-ic {closed ? 'closed' : 'open'}"
					><Icon name={closed ? "iclosed" : "iopen"} size={17} /></span
				>
				<span class="iss-main">
					<span class="iss-title-row">
						<span class="iss-title">{it.title}</span>
						{#if it.kind === "question"}<span class="iss-label" style="--h:142">question</span>{/if}
						{#if it.kind === "idea"}<span class="iss-label" style="--h:48">idea</span>{/if}
						{#if it.up_next}<span class="iss-label" style="--h:32">up next</span>{/if}
						{#if it.priority <= 1}<span class="iss-label" style="--h:2">priority</span>{/if}
						{#if projName(it.project_id)}<span
								class="iss-label"
								style="--h:{labelHue(projName(it.project_id))}">{projName(it.project_id)}</span
							>{/if}
					</span>
					<span class="iss-meta mono">
						#{it.id} · {closed ? "closed" : "opened"}
						{relShort(it.updated_at || it.created_at)} ago{#if author}&nbsp;by&nbsp;<b
								style="color:{whoColor(author)}">{author}</b
							>{/if}
					</span>
				</span>
				<span class="iss-right">
					{#if it.assignee}{@render avatar(it.assignee, 20)}{/if}
					{#if it.ncomments > 0}<span class="iss-comments"
							><Icon name="comment" size={13} /> {it.ncomments}</span
						>{/if}
				</span>
			</a>
		{:else}
			<div class="iss-empty">no {data.tab} issues.</div>
		{/each}

		{#if data.rows.length && (data.page > 0 || data.hasMore)}
			<nav class="iss-pager mono" aria-label="issue pages">
				{#if data.page > 0}<a class="pg" href={pageHref(data.page - 1)}>← newer</a>{:else}<span
						class="pg dis">← newer</span
					>{/if}
				<span class="pg-range">{firstIdx}–{lastIdx}</span>
				{#if data.hasMore}<a class="pg" href={pageHref(data.page + 1)}>older →</a>{:else}<span
						class="pg dis">older →</span
					>{/if}
			</nav>
		{/if}
	</div>
</div>

<style>
	.iss-tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		text-decoration: none;
	}
	.iss-pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		padding: 16px 0 4px;
		font-size: 12px;
	}
	.iss-pager .pg {
		text-decoration: none;
		color: var(--text-2);
		padding: 4px 10px;
		border: 1px solid var(--line, var(--text-4));
		border-radius: 6px;
	}
	.iss-pager .pg:hover {
		color: var(--accent-b);
	}
	.iss-pager .pg.dis {
		color: var(--text-4);
		border-color: transparent;
		pointer-events: none;
	}
	.iss-pager .pg-range {
		color: var(--text-3);
	}
</style>
