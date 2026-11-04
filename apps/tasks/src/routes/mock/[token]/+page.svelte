<script>
	import { enhance } from "$app/forms";
	let { data, form } = $props();

	const isAnswered = (q) => {
		const r = data.results[q.id];

		return q.multi ? r?.choices?.length > 0 : !!r?.choice;
	};
	const answered = $derived(data.spec.questions.filter(isAnswered).length);
	const total = $derived(data.spec.questions.length);
	const rawUrl = (slug) => `/gallery/${encodeURIComponent(slug)}/raw`;
</script>

<svelte:head><title>{data.title} · mock session</title></svelte:head>

<div class="wrap">
	<header class="head">
		<a class="back mono" href="/gallery">&larr; gallery</a>
		<div class="head-row">
			<h1>{data.title}</h1>
			<span class="status" class:done={data.status === "resolved"}>
				{data.status === "resolved" ? "all decided" : `${answered} of ${total} decided`}
			</span>
		</div>
		{#if data.spec.intro}<p class="intro">{data.spec.intro}</p>{/if}
		<p class="how">
			Make your picks — they record straight back to an agent. (Multi-select questions let you check
			every one you like.)
		</p>
	</header>

	{#each data.spec.questions as q, i (q.id)}
		{@const saved = data.results[q.id]}
		<section class="q">
			<div class="q-head">
				<span class="q-num mono">{i + 1}</span>
				<div>
					<h2>{q.prompt}</h2>
					{#if q.note}<p class="q-note">{q.note}</p>{/if}
				</div>
			</div>

			<form method="POST" action="?/choose" use:enhance class="q-form">
				<input type="hidden" name="questionId" value={q.id} />

				<div class="opts" data-n={q.options.length}>
					{#each q.options as opt (opt.key)}
						<label class="opt">
							{#if q.multi}
								<input
									type="checkbox"
									name="choices"
									value={opt.key}
									checked={saved?.choices?.includes(opt.key)}
								/>
							{:else}
								<input
									type="radio"
									name="choice"
									value={opt.key}
									checked={saved?.choice === opt.key}
									required
								/>
							{/if}
							<div class="opt-bar">
								<span class="opt-key mono">{opt.key.toUpperCase()}</span>
								<span class="opt-label">{opt.label}</span>
								{#if opt.link}<a
										class="opt-full mono"
										href={opt.link}
										target="_blank"
										rel="noopener"
										onclick={(e) => e.stopPropagation()}>repo ↗</a
									>{:else if opt.slug}<a
										class="opt-full mono"
										href={`/gallery/${encodeURIComponent(opt.slug)}`}
										target="_blank"
										rel="noopener"
										onclick={(e) => e.stopPropagation()}>open ↗</a
									>{/if}
								<span class="opt-check" aria-hidden="true">✓</span>
							</div>
							{#if opt.blurb}<p class="opt-blurb">{opt.blurb}</p>{/if}
							{#if opt.slug}
								<div class="frame">
									<iframe
										title={opt.label}
										src={rawUrl(opt.slug)}
										sandbox="allow-scripts allow-downloads"
										referrerpolicy="no-referrer"
										loading="lazy"
									></iframe>
								</div>
							{/if}
						</label>
					{/each}
				</div>

				<div class="q-foot">
					<input
						class="comment"
						name="comment"
						placeholder="Add a note (optional)…"
						value={saved?.comment ?? ""}
						autocomplete="off"
					/>
					<button type="submit" class="save"
						>{isAnswered(q)
							? q.multi
								? "Update picks"
								: "Update pick"
							: q.multi
								? "Save my picks"
								: "Save my pick"}</button
					>
				</div>

				{#if form?.error && form?.questionId === q.id}
					<p class="err">{form.error}</p>
				{:else if q.multi && saved?.choices?.length}
					<p class="ok">
						<span class="dot" aria-hidden="true"></span>Saved {saved.choices.length}:
						<b>{saved.choices.map((k) => q.options.find((o) => o.key === k)?.label).join(", ")}</b>
					</p>
				{:else if saved?.choice}
					<p class="ok">
						<span class="dot" aria-hidden="true"></span>Saved:
						<b>{q.options.find((o) => o.key === saved.choice)?.label}</b>
					</p>
				{/if}
			</form>
		</section>
	{/each}
</div>

<style>
	.wrap {
		max-width: 1040px;
		margin: 0 auto;
		padding: 22px 20px 64px;
	}

	.back {
		display: inline-block;
		color: var(--text-3);
		text-decoration: none;
		font-size: 12px;
		margin-bottom: 14px;
	}
	.back:hover {
		color: var(--accent-b);
	}

	.head {
		margin-bottom: 28px;
	}
	.head-row {
		display: flex;
		align-items: baseline;
		gap: 14px;
		flex-wrap: wrap;
	}
	h1 {
		font-size: 23px;
		font-weight: 750;
		color: var(--text-1);
		margin: 0;
		letter-spacing: -0.02em;
	}
	.status {
		font-size: 12px;
		color: var(--text-3);
		background: var(--surface-2);
		border: 1px solid var(--border-sub);
		border-radius: 999px;
		padding: 3px 11px;
		font-variant-numeric: tabular-nums;
	}
	.status.done {
		color: var(--violet-b);
		border-color: var(--violet-ln);
		background: var(--violet-bg);
	}
	.intro {
		color: var(--text-2);
		font-size: 14.5px;
		line-height: 1.6;
		margin: 12px 0 0;
	}
	.how {
		color: var(--text-4);
		font-size: 12.5px;
		line-height: 1.55;
		margin: 10px 0 0;
	}

	.q {
		margin-top: 30px;
	}
	.q-head {
		display: flex;
		gap: 13px;
		align-items: flex-start;
		margin-bottom: 16px;
	}
	.q-num {
		flex: none;
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		font-size: 13px;
		color: var(--accent-b);
		background: var(--accent-bg);
		border: 1px solid var(--accent-ln);
		border-radius: 999px;
	}
	h2 {
		font-size: 17px;
		font-weight: 650;
		color: var(--text-1);
		margin: 2px 0 0;
		letter-spacing: -0.01em;
	}
	.q-note {
		color: var(--text-3);
		font-size: 13px;
		line-height: 1.55;
		margin: 5px 0 0;
	}

	.opts {
		display: grid;
		gap: 14px;
		grid-template-columns: 1fr 1fr;
	}
	.opts[data-n="1"],
	.opts[data-n="3"] {
		grid-template-columns: 1fr 1fr;
	}
	@media (max-width: 720px) {
		.opts {
			grid-template-columns: 1fr;
		}
	}

	.opt {
		display: block;
		position: relative;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 13px 14px 14px;
		cursor: pointer;
		transition:
			border-color 0.14s,
			background 0.14s,
			box-shadow 0.14s;
	}
	/* the visually-hidden input must be contained in its own card, NOT positioned against the
     page — otherwise tapping a card focuses a top-of-page input and the browser scrolls there
     ("flys off the page" on mobile). position:relative on .opt keeps it local. */
	.opt:hover {
		border-color: var(--surface-3);
	}
	.opt input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.opt:has(input:checked) {
		border-color: var(--accent);
		background: var(--accent-bg);
		box-shadow: inset 0 0 0 1px var(--accent);
	}

	.opt-bar {
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.opt-key {
		flex: none;
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-2);
		background: var(--surface-2);
		border: 1px solid var(--border-sub);
		border-radius: 6px;
	}
	.opt:has(input:checked) .opt-key {
		color: var(--accent-b);
		background: var(--accent-bg);
		border-color: var(--accent-ln);
	}
	.opt-label {
		font-size: 14px;
		font-weight: 550;
		color: var(--text-1);
		flex: 1;
		min-width: 0;
	}
	.opt-full {
		font-size: 11px;
		color: var(--text-4);
		text-decoration: none;
		flex: none;
	}
	.opt-full:hover {
		color: var(--accent-b);
	}
	.opt-check {
		flex: none;
		color: var(--accent-b);
		font-weight: 700;
		opacity: 0;
		transition: opacity 0.14s;
	}
	.opt:has(input:checked) .opt-check {
		opacity: 1;
	}
	.opt-blurb {
		color: var(--text-3);
		font-size: 12.5px;
		line-height: 1.5;
		margin: 7px 0 0;
	}

	.frame {
		margin-top: 11px;
		border: 1px solid var(--border-sub);
		border-radius: var(--radius);
		overflow: hidden;
		background: #0a0a0a;
	}
	/* preview is non-interactive so clicking anywhere on the card selects the option;
     "open ↗" gives the full interactive design in its own tab. */
	.frame iframe {
		width: 100%;
		height: 440px;
		border: 0;
		display: block;
		pointer-events: none;
	}

	.q-foot {
		display: flex;
		gap: 10px;
		margin-top: 14px;
		align-items: center;
	}
	.comment {
		flex: 1;
		min-width: 0;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 10px 13px;
		color: var(--text-1);
		font: inherit;
		font-size: 13.5px;
	}
	.comment::placeholder {
		color: var(--text-4);
	}
	.comment:focus {
		outline: none;
		border-color: var(--accent);
	}
	.save {
		flex: none;
		font: inherit;
		font-size: 13.5px;
		font-weight: 600;
		cursor: pointer;
		background: var(--accent);
		color: #1a0f0c;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		padding: 10px 18px;
	}
	.save:hover {
		background: var(--accent-b);
		border-color: var(--accent-b);
	}

	.ok {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--text-2);
		font-size: 13px;
		margin: 12px 0 0;
	}
	.ok .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--violet-b);
		flex: none;
	}
	.ok b {
		color: var(--text-1);
		font-weight: 600;
	}
	.err {
		color: var(--danger-b);
		font-size: 13px;
		margin: 12px 0 0;
	}
</style>
