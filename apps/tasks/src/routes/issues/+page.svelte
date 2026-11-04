<script>
	import Icon from "$lib/Icon.svelte";
	import { projectName, whoColor } from "$lib/people.js";
	let { data } = $props();
	let tab = $state("open");

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

	const list = $derived(tab === "open" ? data.open : data.closed);
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
			{data.open.length} open · {data.closed.length} closed · {data.projectCount} projects
		</p>
	</header>

	<div class="iss-list">
		<div class="iss-tabs">
			<button class:on={tab === "open"} onclick={() => (tab = "open")}
				><Icon name="iopen" size={15} /> {data.open.length} Open</button
			>
			<button class:on={tab === "closed"} onclick={() => (tab = "closed")}
				><Icon name="iclosed" size={15} /> {data.closed.length} Closed</button
			>
		</div>

		{#each list as it (it.id)}
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
			<div class="iss-empty">no {tab} issues.</div>
		{/each}
	</div>
</div>
