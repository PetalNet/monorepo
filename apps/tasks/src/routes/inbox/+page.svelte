<script>
	import { enhance } from "$app/forms";
	import Icon from "$lib/Icon.svelte";
	import { projectName } from "$lib/people.js";
	import TaskRow from "$lib/TaskRow.svelte";
	let { data } = $props();
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
	const answerLabel = (q) => q.opts.find((o) => o.value === q.answer)?.label ?? q.answer;

	const stats = $derived([
		{ k: "open", v: data.counts.open, strong: data.counts.open > 0 },
		{ k: "answered", v: data.counts.answered },
		{ k: "in progress", v: data.counts.doing },
		{ k: "docs", v: data.counts.docs },
	]);
</script>

<svelte:head><title>inbox · tasks</title></svelte:head>

<div class="screen inbox">
	<header class="page-head">
		<h1>inbox</h1>
		<p class="ph-sub mono">
			{data.counts.open} open · {data.counts.answered} answered all-time · the async loop, in one place
		</p>
		<dl class="statstrip">
			{#each stats as s}
				<div>
					<dt>{s.k}</dt>
					<dd class={s.strong ? "strong" : ""}>{s.v}</dd>
				</div>
			{/each}
		</dl>
	</header>

	{#if data.open.length === 0}
		<div class="caughtup">
			<span class="cu-check"><Icon name="check" size={20} /></span>
			<span>all caught up — nothing waiting on you.</span>
		</div>
	{:else}
		<section class="block">
			<h2 class="block-h">open · waiting on you</h2>
			<div class="list">
				{#each data.open as q (q.id)}
					<div class="row kind-question st-todo needs-human" style="--pl:var(--violet)">
						<span class="row-ic"><Icon name="question" size={16} /></span>
						<div class="row-main">
							<a class="row-title" href="/task/{q.id}">{q.title}</a>
							<span class="row-sub">
								{#if projName(q.project_id)}<span class="mono dim">{projName(q.project_id)}</span
									>{/if}
								<span class="mono dim">asked {relShort(q.created_at)} ago</span>
							</span>
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

	<!-- the two-way notification loop is the next build (imported data); shown as the roadmap, not faked -->
	<section class="block">
		<h2 class="block-h">notifications · both ways</h2>
		<div class="loop-soon">
			<span class="ls-ic"><Icon name="bolt" size={15} /></span>
			<div>
				<div class="ls-title">the async loop closes here next</div>
				<p class="loop-cap mono">
					→ a push when you're mentioned · → import-inbox.jsonl write-back · cold agents read it on
					SessionStart
				</p>
			</div>
		</div>
	</section>

	{#if data.answered.length}
		<section class="block">
			<h2 class="block-h">recently answered</h2>
			<div class="list answered-list">
				{#each data.answered as q (q.id)}
					<TaskRow task={q} project={projName(q.project_id)} showStatus={false}>
						{#snippet meta()}<span class="ans mono">→ {answerLabel(q)}</span>{/snippet}
					</TaskRow>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	/* widen off the narrow editorial column (an operator) */
	.inbox {
		max-width: 1200px;
	}
	.answered-list {
		gap: 0;
	}
	.answered-list > :global(.trow) + :global(.trow) {
		border-top: 1px solid var(--border-sub);
	}

	.loop-soon {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 15px 16px;
		background: var(--surface-1);
		border: 1px dashed var(--border);
		border-radius: var(--radius-lg);
	}
	.ls-ic {
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--accent-bg);
		color: var(--accent-b);
	}
	.ls-title {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--text-2);
		margin-bottom: 4px;
	}
	.loop-cap {
		font-size: 11px;
		color: var(--text-4);
		line-height: 1.6;
	}
	.ans {
		color: var(--violet-b);
	}
	.row.kind-question .row-sub {
		margin-top: 3px;
	}
	.q-answer {
		display: flex;
		align-items: center;
		gap: 7px;
		flex-wrap: wrap;
		margin-top: 9px;
	}
	.q-answer form {
		display: contents;
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
	.row.kind-question {
		align-items: flex-start;
	}
	.row.kind-question .row-ic {
		padding-top: 2px;
	}
</style>
