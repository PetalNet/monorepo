<script>
	import { enhance } from "$app/forms";
	export let data;
	const fmt = (at) => (at ? at.replace(" (Homelab)", " · Homelab") : "");
</script>

<svelte:head><title>{data.plan.title} · Plan · tasks</title></svelte:head>

<main class="plan-page">
	<a class="back" href="/task/{data.plan.id}">← task detail</a>
	<header>
		<p class="eyebrow">Plan</p>
		<h1>{data.plan.title}</h1>
		<p class="byline">{data.plan.created_by || "an agent"} · {data.plan.updated_at}</p>
	</header>

	<section class="plan-prose prose">
		{@html data.bodyHtml}
	</section>

	<section class="plan-section" aria-labelledby="decisions">
		<div class="section-head">
			<h2 id="decisions">Decisions</h2>
			<span>{data.decisions.length} recorded</span>
		</div>
		{#each data.decisions as decision}
			<article class="decision">
				<div class="decision-meta">
					<strong>{decision.created_by || "Someone"}</strong><span
						>{fmt(decision.answer_at || decision.updated_at)}</span
					>
				</div>
				<h3>{decision.title}</h3>
				<p class="choice">{decision.answer}</p>
				<div class="rationale">
					<p><strong>Why</strong></p>
					{@html decision.rationaleHtml}
				</div>
			</article>
		{/each}
	</section>

	<section class="plan-section" aria-labelledby="open-questions">
		<div class="section-head">
			<h2 id="open-questions">Open questions</h2>
			<span>{data.questions.length} waiting</span>
		</div>
		{#each data.questions as question}
			<article class="question">
				<h3>{question.title}</h3>
				{#if question.body}<div class="rationale">{@html question.contextHtml}</div>{/if}
				{#if data.canWrite}
					<form method="POST" action="?/answer" use:enhance>
						<input type="hidden" name="question_id" value={question.id} />
						{#each question.options as option}
							{@const value = typeof option === "object" ? (option.value ?? option.label) : option}
							{@const label = typeof option === "object" ? (option.label ?? option.value) : option}
							<button name="value" {value} type="submit">{label}</button>
						{/each}
						{#if !question.options.length}<input
								name="value"
								required
								placeholder="Record an answer"
							/><button type="submit">Answer</button>{/if}
					</form>
				{/if}
			</article>
		{/each}
	</section>

	<section class="plan-section comments" aria-labelledby="comments">
		<div class="section-head">
			<h2 id="comments">Discussion</h2>
			<span>{data.comments.length} comments</span>
		</div>
		{#each data.comments as comment}
			<article class="comment">
				<strong>{comment.author || "Someone"}</strong><span>{comment.created_at}</span>
				<p>{comment.body}</p>
			</article>
		{/each}
		{#if data.canWrite}
			<form
				method="POST"
				action="?/comment"
				use:enhance={() =>
					async ({ update }) =>
						update({ reset: true })}
			>
				<textarea name="body" required placeholder="Add a comment"></textarea><button type="submit"
					>Comment</button
				>
			</form>
		{/if}
	</section>
</main>

<style>
	.plan-page {
		max-width: 900px;
		margin: 0 auto;
		padding: 40px 22px 72px;
		color: var(--text);
	}
	.back {
		color: var(--accent-b);
		font-size: 0.9rem;
	}
	header {
		margin: 38px 0;
	}
	.eyebrow,
	.byline,
	.section-head span,
	.decision-meta,
	.comment span {
		color: var(--mute);
		font-size: 0.84rem;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	h1 {
		font-size: 2.35rem;
		line-height: 1.08;
		margin: 8px 0;
	}
	h2 {
		font-size: 1.2rem;
	}
	h3 {
		font-size: 1rem;
		line-height: 1.35;
		margin: 9px 0;
	}
	.plan-prose {
		max-width: 72ch;
		line-height: 1.7;
	}
	.plan-prose :global(h2) {
		margin: 2.6em 0 0.7em;
		display: flex;
		gap: 10px;
		align-items: center;
	}
	.plan-prose :global(.plan-status) {
		font: 0.72rem var(--mono);
		border-radius: 999px;
		padding: 3px 8px;
		text-transform: uppercase;
	}
	.plan-prose :global(.plan-status-proposed) {
		color: var(--warn-b);
		background: color-mix(in srgb, var(--warn) 16%, transparent);
	}
	.plan-prose :global(.plan-status-decided) {
		color: var(--accent-b);
		background: var(--accent-bg);
	}
	.plan-prose :global(.plan-status-done) {
		color: var(--violet-b);
		background: var(--violet-bg);
	}
	.plan-section {
		border-top: 1px solid var(--border);
		margin-top: 44px;
		padding-top: 22px;
	}
	.section-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 16px;
	}
	.decision,
	.question,
	.comment {
		padding: 17px 0;
		border-top: 1px solid var(--border-sub);
	}
	.decision:first-of-type,
	.question:first-of-type,
	.comment:first-of-type {
		border-top: 0;
	}
	.decision-meta,
	.comment {
		display: flex;
		gap: 9px;
		flex-wrap: wrap;
	}
	.choice {
		color: var(--violet-b);
		font-weight: 600;
		line-height: 1.45;
	}
	.rationale {
		color: var(--text-2);
		line-height: 1.55;
	}
	.question form,
	.comments form {
		margin-top: 14px;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	button {
		border: 1px solid var(--accent-ln);
		border-radius: var(--radius-sm);
		background: var(--accent-bg);
		padding: 8px 11px;
		cursor: pointer;
	}
	input,
	textarea {
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		padding: 9px;
		background: var(--surface);
		color: var(--text);
	}
	textarea {
		width: min(100%, 640px);
		min-height: 76px;
		display: block;
	}
	.comment p {
		width: 100%;
		margin: 0;
	}
	@media (max-width: 520px) {
		.plan-page {
			padding: 26px 16px 52px;
		}
		h1 {
			font-size: 1.9rem;
		}
		.plan-prose :global(h2) {
			align-items: flex-start;
			flex-direction: column;
			gap: 5px;
		}
	}
</style>
