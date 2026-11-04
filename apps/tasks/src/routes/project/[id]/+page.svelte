<script>
	import Icon from "$lib/Icon.svelte";
	import { whoColor as whoColorBase } from "$lib/people.js";
	let { data } = $props();

	// per-person colours single-sourced from $lib/people; this page's falsy fallback is null.
	const whoColor = (h) => whoColorBase(h, null);
	const AGENTS = Object.entries(data.config?.people ?? {}).filter(([, person]) => person.kind === "agent").map(([handle]) => handle);
	const isAgent = (h) => AGENTS.includes(String(h).toLowerCase());

	const kindIcon = (k) =>
		k === "idea" ? "idea" : k === "doc" ? "doc" : k === "question" ? "question" : "task";

	// group the flat list into the same lanes as the board (in priority/rank order from the server).
	const LANES = [
		{ key: "doing", title: "In progress", icon: "bolt" },
		{ key: "upnext", title: "Up next", icon: "bolt" },
		{ key: "todo", title: "To do", icon: "task" },
		{ key: "inbox", title: "Inbox", icon: "idea" },
		{ key: "blocked", title: "Blocked", icon: "block" },
		{ key: "review", title: "In review", icon: "iopen" },
		{ key: "done", title: "Done", icon: "check" },
	];
	const laneOf = (t) => {
		if (t.status === "doing") {
			return "doing";
		}

		if (t.status === "blocked") {
			return "blocked";
		}

		if (t.status === "review") {
			return "review";
		}

		if (t.status === "done" || t.status === "dropped") {
			return "done";
		}

		if (t.status === "inbox") {
			return "inbox";
		}

		if (t.up_next) {
			return "upnext";
		}

		return "todo";
	};
	const grouped = $derived.by(() => {
		const g = {};

		for (const t of data.tasks) {
			(g[laneOf(t)] ??= []).push(t);
		}

		return g;
	});
	const lanes = $derived(
		LANES.map((l) => ({ ...l, items: grouped[l.key] ?? [] })).filter((l) => l.items.length),
	);

	const total = $derived(data.tasks.length);
	const openCount = $derived(
		data.tasks.filter((t) => t.status !== "done" && t.status !== "dropped").length,
	);
</script>

<svelte:head><title>{data.project.name} · tasks</title></svelte:head>

<div class="screen project">
	<a class="back" href="/projects"><Icon name="arrow" size={13} /> projects</a>

	<header class="page-head">
		<div class="ph-row">
			<h1>{data.project.name}</h1>
			<span class="ph-tag mono"
				><span style="vertical-align:-1px"><Icon name="lock" size={11} /></span>
				{data.project.visibility}{#if data.project.owner}
					· {data.project.owner}{/if}</span
			>
			<span class="ph-spacer"></span>
			<a class="back" href="/?project={encodeURIComponent(data.project.name)}"
				><Icon name="board" size={13} /> on board</a
			>
		</div>
		<p class="ph-sub mono">{total} item{total === 1 ? "" : "s"} · {openCount} open</p>
	</header>

	{#if lanes.length}
		<div class="lanes">
			{#each lanes as lane (lane.key)}
				<section class="lane">
					<div class="lane-head">
						<span class="lane-ic"><Icon name={lane.icon} size={14} /></span>
						<h2>{lane.title}</h2>
						<span class="lane-count">{lane.items.length}</span>
					</div>
					<div class="lane-body">
						{#each lane.items as t (t.id)}
							{@const pc = whoColor(t.assignee)}
							<a class="row kind-{t.kind} st-{t.status ?? 'todo'}" href="/task/{t.id}">
								<span class="row-ic"><Icon name={kindIcon(t.kind)} size={16} /></span>
								<span class="row-main">
									<span class="row-title">{t.title}</span>
									<span class="row-sub">
										<span class="tasknum mono">#{t.id}</span>
										{#if t.priority != null}<span class="chip prio prio-{t.priority}"
												>P{t.priority}</span
											>{/if}
										{#if t.visibility === "private"}<span class="tag-s mono">private</span>{/if}
									</span>
								</span>
								<span class="row-right">
									{#if t.assignee}
										<span
											class="avatar"
											style="width:20px;height:20px;font-size:9px;color:{pc};border-color:{pc};background:{isAgent(
												t.assignee,
											)
												? 'transparent'
												: pc + '22'};border-style:{isAgent(t.assignee) ? 'dashed' : 'solid'}"
											>{t.assignee.charAt(0).toLowerCase()}</span
										>
									{/if}
								</span>
							</a>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{:else}
		<p class="empty">No items in this project yet.</p>
	{/if}
</div>

<style>
	.project .back {
		text-decoration: none;
	}
	.project .lanes {
		display: flex;
		flex-direction: column;
		gap: 26px;
	}
	.project .row {
		text-decoration: none;
	}
	.empty {
		color: var(--text-4);
		font-size: 13px;
	}
</style>
