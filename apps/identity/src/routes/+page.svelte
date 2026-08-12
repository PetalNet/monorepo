<script lang="ts">
	import type { PageData } from "./$types";

	const { data }: { data: PageData } = $props();

	let question = $state("");

	const answer = $derived.by(() => {
		const match = /^\s*(?:why\s+can(?:'t|not)?\s+)?(\S+)\s+(?:access\s+)?(\S+?)\??\s*$/i.exec(question);
		if (!match) return null;
		const [, who, what] = match;
		const row = data.explain.find(
			(r) => r.personId.toLowerCase() === who!.toLowerCase() && r.resourceId.toLowerCase() === what!.toLowerCase(),
		);
		return row ?? { notFound: true, who: who!, what: what! };
	});
</script>

<svelte:head><title>PetalNet Identity</title></svelte:head>

<main>
	<header>
		<h1>PetalNet Identity</h1>
		<p class="read-at">
			{data.evidence.checks} access checks, verified {data.evidence.ageSeconds}s ago in
			{(data.evidence.durationMs / 1000).toFixed(1)}s{#if data.evidence.unknownCount}, {data.evidence.unknownCount} could not be checked{/if}
			{#if data.evidence.stale}<strong class="stale">STALE</strong>{/if}
			<a href="?refresh">re-run</a>
		</p>
	</header>

	{#if data.state.error}
		<section class="alarm">
			<h2>Could not read Authentik</h2>
			<p>{data.state.error}</p>
			<p class="note">
				Nothing below is current. This is missing information, not a clean result — the
				difference matters, so the page refuses to show a calm dashboard it cannot stand behind.
			</p>
		</section>
	{:else}
		<section class:alarm={data.state.gate.blocked} class:ok={!data.state.gate.blocked} class="gate">
			<h2>{data.state.gate.blocked ? "Creating a person is blocked" : "Safe to create people"}</h2>
			<p>{data.state.gate.reason}</p>
			{#if data.state.gate.unboundApplications.length}
				<p class="mono">{data.state.gate.unboundApplications.join("  ")}</p>
			{/if}
		</section>

		<section>
			<h2>Ask</h2>
			<input
				type="text"
				bind:value={question}
				placeholder="why can elisha access grafana"
				aria-label="Access question"
			/>
			{#if answer && "notFound" in answer}
				<p class="note">No such person or application: {answer.who} / {answer.what}</p>
			{:else if answer}
				<div class="explanation">
					<div class="verdict" class:allow={answer.decision === "allow"}>
						{answer.personId} → {answer.resourceId}: {answer.decision.toUpperCase()}
					</div>
					<pre>{answer.tree}</pre>
					<dl>
						<dt>Intended</dt><dd>{answer.intended.toUpperCase()}</dd>
						<dt>Configured</dt><dd>{answer.configured.toUpperCase()}</dd>
						<dt>Evaluated</dt><dd>{answer.evaluated.toUpperCase()}</dd>
					</dl>
					{#if answer.disagreement}
						<p class="disagree">{answer.disagreement}</p>
					{/if}
				</div>
			{/if}
		</section>

		<section>
			<h2>Findings <span class="count">{data.state.findings.length}</span></h2>
			{#if data.state.findings.length === 0}
				<p class="note">Nothing requires attention.</p>
			{:else}
				<ul class="findings">
					{#each data.state.findings as finding (finding.id)}
						<li class={finding.severity}>
							<div class="kind">{finding.kind.replaceAll("_", " ")}</div>
							<div class="subject">{finding.subject}</div>
							<p>{finding.explanation}</p>
							<p class="evidence">{finding.evidence}</p>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section>
			<h2>People <span class="count">{data.state.people.length}</span></h2>
			<div class="scroll">
				<table>
					<thead>
						<tr><th>Username</th><th>Name</th><th>Roles</th><th>Reaches</th><th>Unmapped groups</th></tr>
					</thead>
					<tbody>
						{#each data.state.people as person (person.id)}
							<tr>
								<td class="mono">{person.username}</td>
								<td>{person.displayName}</td>
								<td>{person.roleIds.join(", ") || "—"}</td>
								<td class="num">{person.reaches}</td>
								<td class="mono dim">{person.unmappedGroups.join(" ") || "—"}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section>
			<h2>Applications <span class="count">{data.state.resources.length}</span></h2>
			<div class="scroll">
				<table>
					<thead><tr><th>Application</th><th>Bound to</th><th>Who reaches it</th></tr></thead>
					<tbody>
						{#each data.state.resources as resource (resource.slug)}
							<tr class:unbound={resource.unbound}>
								<td>{resource.name}<span class="slug mono">{resource.slug}</span></td>
								<td>{resource.unbound ? "NOTHING — open to every account" : resource.boundTo.join(", ")}</td>
								<td class="mono dim">{resource.reachedBy.join(" ") || "—"}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section>
			<h2>Machines <span class="count">{data.state.machines.length}</span></h2>
			<p class="note">
				Service accounts and outposts, kept out of the People list on purpose. Most lab agents
				do not appear here at all — they authenticate with bearer tokens and Matrix accounts,
				not Authentik, so this list is not the fleet.
			</p>
			<p class="mono dim">{data.state.machines.map((m) => m.username).join("  ")}</p>
		</section>
	{/if}
</main>

<style>
	:global(:root) {
		--ink: #17181c;
		--ink-2: #4a4d57;
		--ink-3: #74788a;
		--paper: #f7f6f3;
		--surface: #fffefc;
		--rule: #dedbd3;
		--accent: #9c4221;
		--danger: #a3241e;
		--danger-soft: #f6e3e1;
		--ok: #2f6b46;
		--ok-soft: #e2efe7;
		--mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme="light"])) {
			--ink: #eceae5;
			--ink-2: #b6b3ab;
			--ink-3: #8a877f;
			--paper: #14151a;
			--surface: #1b1d23;
			--rule: #31343c;
			--accent: #e08a5f;
			--danger: #e58a80;
			--danger-soft: #331e1c;
			--ok: #7cc79b;
			--ok-soft: #1b2b22;
		}
	}
	:global(body) {
		margin: 0;
		background: var(--paper);
		color: var(--ink);
		font-family: ui-sans-serif, system-ui, sans-serif;
		line-height: 1.55;
	}
	main {
		max-width: 66rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 5rem;
		display: flex;
		flex-direction: column;
		gap: 2.25rem;
	}
	header {
		border-bottom: 2px solid var(--ink);
		padding-bottom: 1rem;
	}
	h1 {
		margin: 0;
		font-size: clamp(1.75rem, 4vw, 2.5rem);
		letter-spacing: -0.02em;
	}
	h2 {
		font-size: 1.15rem;
		margin: 0 0 0.6rem;
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.read-at,
	.note,
	.evidence {
		color: var(--ink-3);
		font-size: 0.85rem;
	}
	.count {
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--ink-3);
	}
	section.alarm {
		background: var(--danger-soft);
		border: 1px solid var(--danger);
		border-radius: 3px;
		padding: 1rem 1.15rem;
	}
	section.alarm h2 {
		color: var(--danger);
	}
	section.ok {
		background: var(--ok-soft);
		border: 1px solid var(--ok);
		border-radius: 3px;
		padding: 1rem 1.15rem;
	}
	input {
		width: 100%;
		padding: 0.6rem 0.75rem;
		font: inherit;
		background: var(--surface);
		color: var(--ink);
		border: 1px solid var(--rule);
		border-radius: 3px;
	}
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.explanation {
		margin-top: 0.9rem;
		background: var(--surface);
		border: 1px solid var(--rule);
		border-radius: 3px;
		padding: 0.9rem 1rem;
	}
	.verdict {
		font-weight: 600;
		color: var(--danger);
	}
	.verdict.allow {
		color: var(--ok);
	}
	pre {
		font-family: var(--mono);
		font-size: 0.85rem;
		margin: 0.6rem 0;
		overflow-x: auto;
	}
	dl {
		display: grid;
		grid-template-columns: auto auto;
		gap: 0.1rem 0.9rem;
		justify-content: start;
		margin: 0;
		font-size: 0.88rem;
	}
	dt {
		color: var(--ink-3);
	}
	dd {
		margin: 0;
		font-family: var(--mono);
	}
	.disagree {
		color: var(--danger);
		font-size: 0.88rem;
		margin-bottom: 0;
	}
	ul.findings {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	ul.findings li {
		background: var(--surface);
		border: 1px solid var(--rule);
		border-radius: 3px;
		padding: 0.7rem 0.9rem;
	}
	ul.findings li.critical {
		border-color: var(--danger);
	}
	.kind {
		font-family: var(--mono);
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		color: var(--danger);
	}
	.subject {
		font-weight: 600;
	}
	ul.findings p {
		margin: 0.2rem 0 0;
		font-size: 0.9rem;
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		min-width: 36rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.4rem 0.6rem;
		border-bottom: 1px solid var(--rule);
		vertical-align: top;
	}
	th {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--ink-3);
	}
	td.num {
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	tr.unbound td {
		background: var(--danger-soft);
	}
	.mono {
		font-family: var(--mono);
		font-size: 0.85em;
	}
	.dim {
		color: var(--ink-3);
	}
	.stale {
		color: var(--danger);
		font-family: var(--mono);
		font-size: 0.72rem;
		letter-spacing: 0.06em;
	}
	a {
		color: var(--accent);
	}
	.slug {
		display: block;
		color: var(--ink-3);
		font-size: 0.75rem;
	}
</style>
