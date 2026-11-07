<script>
	import { enhance } from "$app/forms";
	import Icon from "$lib/Icon.svelte";
	import { whoColor as whoColorBase } from "$lib/people.js";
	let { data } = $props();
	// whoColor single-sourced from $lib/people; this page's falsy-handle fallback is null.
	const whoColor = (h) => whoColorBase(h, null);
</script>

<svelte:head><title>projects · tasks</title></svelte:head>

<div class="screen projects">
	<header class="page-head">
		<h1>projects</h1>
		<p class="ph-sub mono">
			{data.projects.length} project{data.projects.length === 1 ? "" : "s"} · owner + visibility scoping
		</p>
	</header>

	{#if data.projects.length}
		<div class="proj-grid">
			{#each data.projects as p (p.id)}
				{@const pc = whoColor(p.owner)}
				<div class="proj-card" class:priv={p.visibility === "private"}>
					<div class="pc-head">
						<span class="pc-dot"></span>
						<a class="pc-name mono" href="/project/{p.id}">{p.name}</a>
						{#if p.count > 0}<span class="pc-badge">{p.count}</span>{/if}
					</div>
					<div class="pc-meta">
						<span class="pc-vis">
							<Icon name="lock" size={12} />
							{p.visibility}{#if p.owner}
								· {p.owner}{/if}
						</span>
						<a class="pc-board mono" href="/?project={encodeURIComponent(p.name)}">on board →</a>
					</div>
					<div class="pc-manage">
						<form method="POST" action="?/rename" use:enhance class="ren">
							<input type="hidden" name="id" value={p.id} />
							<input class="ren-in mono" name="name" value={p.name} aria-label="Rename project" />
						</form>
						<form method="POST" action="?/visibility" use:enhance>
							<input type="hidden" name="id" value={p.id} />
							<label class="chk mono"
								><input
									type="checkbox"
									name="private"
									checked={p.visibility === "private"}
									onchange={(e) => e.target.form.requestSubmit()}
								/> private</label
							>
						</form>
						<span class="pm-sp"></span>
						<form method="POST" action="?/move" use:enhance class="mv">
							<input type="hidden" name="id" value={p.id} />
							<select name="dest" aria-label="Move into project">
								<option value="">move into…</option>
								{#each data.projects.filter((o) => o.id !== p.id) as o}<option value={o.id}
										>{o.name}</option
									>{/each}
							</select>
							<button
								class="pm-btn"
								onclick={(e) => {
									const s = e.currentTarget.form.dest;

									if (!s.value) {
										e.preventDefault();

										return;
									}

									if (
										!confirm(
											`Move all items from "${p.name}" into "${s.options[s.selectedIndex].text}", then delete "${p.name}"?`,
										)
									) {
										e.preventDefault();
									}
								}}>move</button
							>
						</form>
						<form method="POST" action="?/archive" use:enhance>
							<input type="hidden" name="id" value={p.id} />
							<button
								class="pm-btn"
								onclick={(e) => {
									if (
										!confirm(
											`Archive "${p.name}"? Its tasks hide from active views — restorable, not deleted.`,
										)
									) {
										e.preventDefault();
									}
								}}>archive</button
							>
						</form>
						<form method="POST" action="?/delete" use:enhance>
							<input type="hidden" name="id" value={p.id} />
							<button
								class="pm-btn del"
								onclick={(e) => {
									if (!confirm(`Delete "${p.name}" and all its items?`)) {
										e.preventDefault();
									}
								}}>delete</button
							>
						</form>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<p class="empty">No projects yet.</p>
	{/if}

	{#if data.archived?.length}
		<section class="archived">
			<h2 class="arch-h mono">archived · {data.archived.length}</h2>
			<div class="arch-list">
				{#each data.archived as a (a.id)}
					<div class="arch-row">
						<span class="arch-name mono">{a.name}</span>
						<form method="POST" action="?/unarchive" use:enhance>
							<input type="hidden" name="name" value={a.name} />
							<button class="pm-btn">restore</button>
						</form>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	.pc-name {
		text-decoration: none;
	}
	.pc-name:hover {
		color: var(--accent-b);
	}
	.pc-board {
		margin-left: auto;
		color: var(--text-4);
		text-decoration: none;
		transition: color 0.12s;
	}
	.pc-board:hover {
		color: var(--accent-b);
	}
	.pc-vis svg {
		vertical-align: -1px;
		margin-right: 2px;
	}
	.pc-manage {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		padding-top: 11px;
		margin-top: 2px;
		border-top: 1px solid var(--border-sub);
	}
	.ren {
		flex: 1;
		min-width: 110px;
	}
	.ren-in {
		width: 100%;
		background: none;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--text-2);
		font-size: 12px;
		padding: 4px 6px;
		outline: 0;
	}
	.ren-in:hover {
		border-color: var(--border-sub);
	}
	.ren-in:focus {
		border-color: var(--accent-ln);
		background: var(--surface-2);
		color: var(--text-1);
	}
	.chk {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		color: var(--text-3);
		cursor: pointer;
	}
	.chk input {
		width: auto;
		accent-color: var(--accent);
	}
	.pm-sp {
		flex: 1;
	}
	.mv {
		display: flex;
		gap: 5px;
		align-items: center;
	}
	.mv select {
		font: inherit;
		font-size: 11px;
		color: var(--text-3);
		background: var(--surface-2);
		border: 1px solid var(--border-sub);
		border-radius: var(--radius-sm);
		padding: 4px 6px;
		max-width: 120px;
		cursor: pointer;
	}
	.pm-btn {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--text-3);
		background: var(--surface-2);
		border: 1px solid var(--border-sub);
		border-radius: var(--radius-sm);
		padding: 4px 9px;
		cursor: pointer;
		transition: 0.12s;
	}
	.pm-btn:hover {
		color: var(--text-1);
		border-color: var(--border);
	}
	.pm-btn.del:hover {
		color: var(--danger-b);
		border-color: var(--danger);
	}
	.empty {
		color: var(--text-4);
		font-size: 13px;
	}
	.archived {
		margin-top: 28px;
		padding-top: 16px;
		border-top: 1px solid var(--border-sub);
	}
	.arch-h {
		font-size: 12px;
		color: var(--text-4);
		margin: 0 0 10px;
	}
	.arch-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.arch-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12px;
	}
	.arch-name {
		color: var(--text-3);
	}
	.arch-row form {
		margin-left: auto;
	}
</style>
