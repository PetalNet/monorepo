<script>
	import { enhance } from "$app/forms";
	import { goto } from "$app/navigation";
	import Icon from "$lib/Icon.svelte";
	import { projectName } from "$lib/people.js";
	import TaskRow from "$lib/TaskRow.svelte";

	let { data } = $props();

	const projName = projectName(data.projects);

	// Compact lease badge for in-progress rows. lease_expires_at now ships (only
	// claim_token is scrubbed); snapshot at render, refreshes on reload/nav.
	function leaseBadge(t) {
		if (t.status !== "doing" || !t.lease_expires_at) return null;
		const s = t.lease_expires_at;
		const ms = new Date(/[TZ]/.test(s) ? s : s.replace(" ", "T") + "Z").getTime();
		if (isNaN(ms)) return null;
		const now = Date.now();
		const a = Math.abs(Math.round((now - ms) / 1000));
		const mag =
			a < 60
				? `${a}s`
				: a < 3600
					? `${Math.round(a / 60)}m`
					: a < 86400
						? `${Math.round(a / 3600)}h`
						: `${Math.round(a / 86400)}d`;
		return {
			state: now >= ms ? "expired" : now > ms - 300000 ? "soon" : "ok",
			label: now >= ms ? `${mag} over` : mag,
		};
	}

	function filterUrl({ project = data.current, assignee = data.assignee } = {}) {
		const q = new URLSearchParams();
		if (project) q.set("project", project);
		if (assignee) q.set("assignee", assignee);
		const s = q.toString();
		return s ? `?${s}` : "?";
	}
	const pickProject = (e) =>
		goto(filterUrl({ project: e.target.value || null }), { keepFocus: true, noScroll: true });
	const pickAssignee = (e) =>
		goto(filterUrl({ assignee: e.target.value || null }), { keepFocus: true, noScroll: true });

	// attention sub-line counts
	const waitingCount = $derived(data.questions.length);

	// ── client-side search ──────────────────────────────────────
	// Browsing a board with 50+ rows across many lanes is a scroll-hunt. A live
	// title/project filter narrows every lane at once (matches a row OR any of its
	// sub-tasks) so you can find a task by typing instead of scanning. Project +
	// assignee dropdowns stay server-side (they re-query); this is a pure in-page
	// narrow of what's already loaded.
	let query = $state("");
	const needle = $derived(query.trim().toLowerCase());
	const rowMatch = (t) =>
		!needle ||
		(t.title ?? "").toLowerCase().includes(needle) ||
		(projName(t.project_id) ?? "").toLowerCase().includes(needle) ||
		(t.kids ?? []).some(rowMatch);
	const f = (list) => (needle ? (list ?? []).filter(rowMatch) : (list ?? []));
	const fQuestions = $derived(f(data.questions));
	const fDoing = $derived(f(data.doing));
	const fUpNext = $derived(f(data.upNext));
	const fInbox = $derived(f(data.inbox));
	const fBacklog = $derived(f(data.backlog));
	const fBlocked = $derived(f(data.blocked));
	const fDocs = $derived(f(data.docs));
	const fDone = $derived(f(data.done));
	const matchCount = $derived(
		fQuestions.length +
			fDoing.length +
			fUpNext.length +
			fInbox.length +
			fBacklog.length +
			fBlocked.length +
			fDocs.length +
			fDone.length,
	);
	const searching = $derived(!!needle);
</script>

<svelte:head><title>browse{data.current ? " · " + data.current : ""}</title></svelte:head>

<!-- one task row + its subtasks, recursively -->
{#snippet row(t)}
	{@const lb = leaseBadge(t)}
	<TaskRow task={t} project={projName(t.project_id)}>
		{#snippet meta()}
			{#if t.blockers?.length}<span class="sep" aria-hidden="true">·</span><span class="blk"
					><Icon name="block" size={11} /> blocked</span
				>{/if}
		{/snippet}
		{#snippet actions()}
			{#if lb}<span class="lease lease-{lb.state}" title="lease {lb.label}">{lb.label}</span>{/if}
			<form method="POST" action="?/update" use:enhance>
				<input type="hidden" name="id" value={t.id} /><input
					type="hidden"
					name="status"
					value="done"
				/>
				<button class="rcheck" title="Complete" aria-label="Mark task done"
					><Icon name="check" size={13} /></button
				>
			</form>
		{/snippet}
	</TaskRow>
	{#each t.kids ?? [] as k, i (k.id)}
		<div class="substack" class:last={i === t.kids.length - 1}>{@render row(k)}</div>
	{/each}
{/snippet}

{#snippet laneHead(title, count, accent, icon)}
	<div class="lane-head {accent ? 'lane-' + accent : ''}">
		{#if icon}<span class="lane-ic"><Icon name={icon} size={14} /></span>{/if}
		<h2>{title}</h2>
		<span class="lane-count">{count}</span>
	</div>
{/snippet}

<div class="screen board">
	<header class="page-head">
		<div class="ph-row">
			<h1>tasks</h1>
			<span class="ph-spacer"></span>
			<div class="ph-filters">
				<div class="fsel">
					{#if data.current}<Icon class="lk" name="lock" size={12} />{/if}
					<select onchange={pickProject} value={data.current ?? ""} aria-label="Project">
						<option value="">all projects</option>
						{#each data.projects as p}<option value={p.name}>{p.name}</option>{/each}
					</select>
				</div>
				{#if data.assignees.length}
					<div class="fsel" class:on={data.assignee}>
						<select onchange={pickAssignee} value={data.assignee ?? ""} aria-label="Assignee">
							<option value="">all people</option>
							{#each data.assignees as a}<option value={a}>{a}</option>{/each}
						</select>
					</div>
				{/if}
			</div>
		</div>
		<p class="ph-sub mono">
			<span class="hl-v">{waitingCount} waiting on you</span>{#if data.doing.length}
				· <span class="hl-a">{data.doing.length} in progress</span>{/if} · {data.upNext.length} up next
			· {data.backlog.length} to do · {data.inbox.length} in inbox
		</p>
	</header>

	<form
		class="capture"
		method="POST"
		action="?/capture"
		use:enhance={() =>
			({ update }) =>
				update({ reset: true })}
	>
		<Icon name="plus" size={18} />
		<input
			name="title"
			placeholder="Capture an idea or task…"
			autocomplete="off"
			aria-label="Capture an idea or task"
		/>
		{#if data.current}<input type="hidden" name="project" value={data.current} />{/if}
		<kbd class="mono">↵</kbd>
	</form>

	<div class="searchbar" class:on={searching}>
		<Icon name="board" size={16} />
		<input
			bind:value={query}
			placeholder="Find a task…"
			autocomplete="off"
			aria-label="Find a task"
			onkeydown={(e) => {
				if (e.key === "Escape") query = "";
			}}
		/>
		{#if searching}
			<span class="sb-count mono">{matchCount} match{matchCount === 1 ? "" : "es"}</span>
			<button type="button" class="sb-clear" onclick={() => (query = "")} aria-label="Clear search"
				>✕</button
			>
		{/if}
	</div>

	{#if searching && matchCount === 0}
		<p class="no-matches mono">
			No tasks match “{query}”.
			<button type="button" class="link-btn" onclick={() => (query = "")}>clear</button>
		</p>
	{/if}

	<div class="lanes">
		{#if fQuestions.length}
			<section class="lane">
				{@render laneHead("Waiting on you", fQuestions.length, "attention", "question")}
				<div class="lane-body">
					{#if !searching}
						<div class="sticky-note">
							<span class="sn-ic"><Icon name="sticky" size={14} /></span>
							<span><b>questions</b> need a typed answer · agents are blocked on you</span>
						</div>
					{/if}
					{#each fQuestions as q (q.id)}
						<div class="row kind-question st-todo needs-human" style="--pl:var(--violet)">
							<span class="row-ic"><Icon name="question" size={16} /></span>
							<div class="row-main">
								<a class="row-title" href="/task/{q.id}"
									>{q.title} <span class="tasknum mono">#{q.id}</span></a
								>
								<div class="q-answer">
									{#each q.opts as o}
										<form method="POST" action="?/answer" use:enhance>
											<input type="hidden" name="id" value={q.id} /><input
												type="hidden"
												name="value"
												value={o.value}
											/>
											<button class="q-opt">{o.label}</button>
										</form>
									{/each}
									{#if !q.opts.length}
										<form method="POST" action="?/answer" use:enhance class="q-free">
											<input type="hidden" name="id" value={q.id} />
											<input
												name="value"
												placeholder="Type an answer…"
												required
												aria-label="Answer"
											/>
											<button class="q-submit-sm">Answer</button>
										</form>
									{/if}
								</div>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if fDoing.length}
			<section class="lane">
				{@render laneHead("In progress", fDoing.length, "active", "bolt")}
				<div class="lane-body">
					{#each fDoing as t (t.id)}{@render row(t)}{/each}
				</div>
			</section>
		{/if}

		{#if !searching || fUpNext.length}
			<section class="lane">
				{@render laneHead("Up next", fUpNext.length, "emerald", "bolt")}
				<div class="lane-body">
					{#each fUpNext as t (t.id)}{@render row(t)}{:else}<p class="lane-empty">
							Nothing queued. Triage an idea up here.
						</p>{/each}
				</div>
			</section>
		{/if}

		{#if !searching || fInbox.length}
			<section class="lane">
				{@render laneHead("Inbox", fInbox.length, "", "idea")}
				<div class="lane-body">
					{#each fInbox as t (t.id)}
						<TaskRow
							task={t}
							project={projName(t.project_id)}
							statusLabel="captured"
							showStatus={false}
						>
							{#snippet actions()}
								<form method="POST" action="?/triage" use:enhance>
									<input type="hidden" name="id" value={t.id} /><input
										type="hidden"
										name="to"
										value="up"
									/><button class="tg up" title="Up Next">↑</button>
								</form>
								<form method="POST" action="?/triage" use:enhance>
									<input type="hidden" name="id" value={t.id} /><input
										type="hidden"
										name="to"
										value="project"
									/><input type="hidden" name="name" value={t.title} /><button
										class="tg"
										title="Make a project">proj</button
									>
								</form>
								<form method="POST" action="?/triage" use:enhance>
									<input type="hidden" name="id" value={t.id} /><input
										type="hidden"
										name="to"
										value="backlog"
									/><button class="tg" title="Backlog">↓</button>
								</form>
								<form method="POST" action="?/triage" use:enhance>
									<input type="hidden" name="id" value={t.id} /><input
										type="hidden"
										name="to"
										value="drop"
									/><button class="tg x" title="Dismiss">✕</button>
								</form>
							{/snippet}
						</TaskRow>
					{:else}<p class="lane-empty">Inbox zero.</p>{/each}
				</div>
			</section>
		{/if}

		{#if !searching || fBacklog.length}
			<section class="lane">
				{@render laneHead("To do", fBacklog.length, "", "task")}
				<div class="lane-body">
					{#each fBacklog as t (t.id)}{@render row(t)}{:else}<p class="lane-empty">
							Backlog clear.
						</p>{/each}
				</div>
			</section>
		{/if}

		{#if fBlocked.length}
			<section class="lane">
				{@render laneHead("Blocked", fBlocked.length, "danger", "block")}
				<div class="lane-body">
					{#each fBlocked as t (t.id)}
						<TaskRow task={t} project={projName(t.project_id)}>
							{#snippet meta()}
								<span class="sep" aria-hidden="true">·</span><span class="blk">blocked by</span>
								{#each t.blockers as b}<span class="tag-s mono">#{b.id}</span>{/each}
							{/snippet}
						</TaskRow>
					{/each}
				</div>
			</section>
		{/if}

		{#if fDocs.length}
			<section class="lane">
				{@render laneHead("Docs", fDocs.length, "", "doc")}
				<div class="lane-body">
					{#each fDocs as d (d.id)}
						<TaskRow task={d} project={projName(d.project_id)} statusLabel="doc" showTime={false} />
					{/each}
				</div>
			</section>
		{/if}
		{#if fDone.length}
			<section class="lane lane-done">
				{@render laneHead("Recently shipped", fDone.length, "", "check")}
				<div class="lane-body">
					{#each fDone as t (t.id)}
						<TaskRow task={t} project={projName(t.project_id)} />
					{/each}
				</div>
			</section>
		{/if}
	</div>
</div>

<style>
	/* widen the board off the narrow editorial column (Bob) — detail keeps its own width */
	.board {
		max-width: 1200px;
	}

	/* flat hairline-separated rows (no gap, no cards) for the shared TaskRow lanes */
	.lane-body {
		gap: 0;
	}
	.lane-body > :global(* + *) {
		border-top: 1px solid var(--border-sub);
	}

	.page-head {
		margin-bottom: 18px;
	}
	.ph-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.ph-spacer {
		flex: 1;
	}
	.ph-filters {
		display: flex;
		gap: 8px;
	}
	.fsel {
		display: flex;
		align-items: center;
		gap: 5px;
		background: var(--surface-1);
		border: 1px solid var(--border-sub);
		border-radius: var(--radius);
		padding: 0 6px 0 10px;
	}
	.fsel .lk {
		color: var(--text-4);
		flex: none;
	}
	.fsel select {
		border: 0;
		background: none;
		color: var(--text-2);
		font: inherit;
		font-size: 12.5px;
		padding: 6px 4px;
		cursor: pointer;
		outline: 0;
	}
	.fsel.on {
		border-color: var(--accent-ln);
	}
	.fsel.on select {
		color: var(--accent-b);
	}

	.capture {
		display: flex;
		align-items: center;
		gap: 11px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 0 14px;
		height: 50px;
		margin: 0 0 24px;
		transition:
			border-color 0.12s,
			box-shadow 0.12s;
	}
	.capture svg {
		color: var(--text-4);
		flex: none;
	}
	.capture input {
		flex: 1;
		border: 0;
		background: none;
		outline: 0;
		color: var(--text-1);
		font: inherit;
		font-size: 15px;
	}
	.capture:focus-within {
		border-color: var(--accent-ln);
		box-shadow: 0 0 0 3px var(--accent-bg);
	}
	.capture kbd {
		font-size: 11px;
		color: var(--text-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 2px 6px;
	}

	/* find-a-task search */
	.searchbar {
		display: flex;
		align-items: center;
		gap: 10px;
		background: var(--surface-1);
		border: 1px solid var(--border-sub);
		border-radius: var(--radius);
		padding: 0 12px;
		height: 40px;
		margin: -10px 0 20px;
		transition:
			border-color 0.12s,
			box-shadow 0.12s;
	}
	.searchbar svg {
		color: var(--text-4);
		flex: none;
	}
	.searchbar input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: none;
		outline: 0;
		color: var(--text-1);
		font: inherit;
		font-size: 14px;
	}
	.searchbar:focus-within,
	.searchbar.on {
		border-color: var(--accent-ln);
		box-shadow: 0 0 0 3px var(--accent-bg);
	}
	.sb-count {
		font-size: 11px;
		color: var(--text-3);
		flex: none;
	}
	.sb-clear {
		flex: none;
		width: 22px;
		height: 22px;
		border-radius: var(--radius-sm);
		border: 0;
		background: var(--surface-2);
		color: var(--text-3);
		font-size: 12px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: 0.12s;
	}
	.sb-clear:hover {
		color: var(--text-1);
		background: var(--border-sub);
	}
	.no-matches {
		font-size: 13px;
		color: var(--text-3);
		padding: 8px 2px 20px;
	}
	.link-btn {
		background: none;
		border: 0;
		color: var(--accent-b);
		font: inherit;
		cursor: pointer;
		text-decoration: underline;
	}

	.lane-empty {
		color: var(--text-4);
		font-size: 13px;
		padding: 4px 2px;
	}

	/* compact lease badge on in-progress rows (mirrors /board + task detail) */
	.lease {
		font-family: var(--mono);
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 9px;
		white-space: nowrap;
	}
	.lease-expired {
		background: rgba(220, 38, 38, 0.14);
		color: var(--danger-b);
	}
	.lease-soon {
		background: rgba(234, 179, 8, 0.14);
		color: var(--warn-b);
	}
	.lease-ok {
		color: var(--text-4);
	}
	.lane-head {
		width: 100%;
	}

	.rcheck {
		width: 22px;
		height: 22px;
		border-radius: var(--radius-sm);
		border: 1.5px solid var(--border);
		color: transparent;
		display: flex;
		align-items: center;
		justify-content: center;
		flex: none;
		transition: 0.12s;
	}
	.rcheck:hover {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-bg);
	}
	.trow-actions form {
		display: flex;
	}

	/* sub-task tree: a continuous trunk down the left, an elbow tick into each child.
     consecutive .substack siblings stack their ::before lines into one unbroken trunk;
     the last child stops its trunk at the elbow so nothing dangles below. */
	.substack {
		position: relative;
		padding-left: 24px;
	}
	.substack::before {
		content: "";
		position: absolute;
		left: 9px;
		top: 0;
		bottom: 0;
		width: 1.5px;
		background: var(--border);
	}
	.substack.last::before {
		bottom: auto;
		height: 18px;
	}
	.substack::after {
		content: "";
		position: absolute;
		left: 9px;
		top: 18px;
		width: 13px;
		height: 1.5px;
		background: var(--border);
	}
	.substack :global(.trow) {
		min-width: 0;
	}
	.blk {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--danger-b);
	}
	.tag-s {
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--text-3);
		background: var(--surface-3);
		padding: 1px 6px;
		border-radius: 5px;
	}
	.sep {
		opacity: 0.55;
	}

	.q-answer {
		display: flex;
		align-items: center;
		gap: 7px;
		flex-wrap: wrap;
		margin-top: 9px;
	}
	.q-opt,
	.q-submit-sm {
		font: inherit;
		font-size: 13px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text-1);
		border-radius: var(--radius);
		padding: 6px 13px;
		cursor: pointer;
		transition: 0.12s;
	}
	.q-opt:hover {
		border-color: var(--violet);
		color: var(--violet-b);
	}
	.q-free {
		display: flex;
		gap: 7px;
		align-items: center;
		flex: 1;
		min-width: 200px;
	}
	.q-free input {
		flex: 1;
		min-width: 0;
		border: 1px solid var(--border);
		background: var(--surface-2);
		border-radius: var(--radius);
		padding: 7px 11px;
		color: var(--text-1);
		font: inherit;
		font-size: 13px;
		outline: 0;
	}
	.q-free input:focus {
		border-color: var(--violet-ln);
	}
	.q-submit-sm {
		background: var(--violet);
		border-color: var(--violet);
		color: #06240f;
		font-weight: 600;
		flex: none;
	}
	.q-submit-sm:hover {
		background: var(--violet-b);
		border-color: var(--violet-b);
	}
	.row.kind-question {
		align-items: flex-start;
	}
	.row.kind-question .row-ic {
		padding-top: 2px;
	}

	.tg {
		font-family: var(--mono);
		font-size: 11px;
		border: 1px solid var(--border-sub);
		background: var(--surface-2);
		color: var(--text-3);
		border-radius: var(--radius-sm);
		padding: 4px 8px;
		cursor: pointer;
		transition: 0.12s;
		min-width: 26px;
	}
	.tg:hover {
		color: var(--text-1);
		border-color: var(--border);
	}
	.tg.up:hover {
		color: var(--accent-b);
		border-color: var(--accent-ln);
	}
	.tg.x:hover {
		color: var(--danger-b);
		border-color: var(--danger);
	}

	/* in-progress lane: amber "live" accent + a pulse on the icon */
	.lane-active :global(.lane-head h2) {
		color: var(--accent-b);
	}
	.lane-active :global(.lane-ic) {
		color: var(--accent-b);
		animation: livepulse 2.4s ease-in-out infinite;
	}
	@keyframes livepulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.45;
		}
	}
	.hl-a {
		color: var(--accent-b);
	}

	/* recently-shipped lane */
	.lane-done {
		opacity: 0.85;
	}

	@media (max-width: 560px) {
		.triage form:nth-child(2) .tg {
			display: none;
		}
	}
</style>
