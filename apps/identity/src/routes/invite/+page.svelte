<script lang="ts">
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	import type { ActionData, PageData } from "./$types";

	const { data, form }: { data: PageData; form: ActionData } = $props();

	let roster = $state("");
	let busy = $state(false);
	let copied = $state<string | null>(null);

	const lineCount = $derived(
		roster.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length,
	);

	async function copy(text: string, key: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = key;
			setTimeout(() => (copied = null), 1500);
		} catch {
			copied = null;
		}
	}

	const allLinks = $derived(
		(form?.created ?? []).map((c) => `${c.displayName || c.username}: ${c.claimUrl}`).join("\n"),
	);
</script>

<svelte:head><title>Invite · PetalNet Identity</title></svelte:head>

<main>
	<a class="back" href={resolve("/")}>Back</a>

	<header>
		<h1>Invite people</h1>
		<p class="dim small">
			Each person gets their own link and picks their own password, so it never passes through you
			or me. Links stop working after the expiry below.
		</p>
	</header>

	{#if data.gate.blocked}
		<section class="card alarm">
			<h2>Blocked</h2>
			<p>{data.gate.reason}</p>
			<p class="mono small">{data.gate.unboundApplications.join("  ")}</p>
			<p class="small">Bind these before inviting anyone. Inviting first hands them everything.</p>
		</section>
	{/if}

	{#if form?.message}
		<div class="card alarm" role="alert">
			<p>{form.message}</p>
			{#if form.unbound}<p class="mono small">{form.unbound.join("  ")}</p>{/if}
		</div>
	{/if}

	{#if form?.created?.length}
		<section class="card ok">
			<h2>{form.created.length} link{form.created.length === 1 ? "" : "s"} created</h2>
			<p class="small">
				These are shown once here. Anyone holding a link becomes that account, so send them to each
				person directly and never into a group chat.
			</p>
			<button class="copyAll" onclick={() => copy(allLinks, "all")}>
				{copied === "all" ? "Copied" : "Copy all"}
			</button>
			<ul class="links">
				{#each form.created as invite (invite.token)}
					<li>
						<div class="who">{invite.displayName || invite.username}</div>
						<div class="link mono">{invite.claimUrl}</div>
						<button onclick={() => copy(invite.claimUrl, invite.token)}>
							{copied === invite.token ? "Copied" : "Copy"}
						</button>
					</li>
				{/each}
			</ul>
			<p class="dim small">Expires {new Date(form.expires).toLocaleString()}</p>
		</section>
	{/if}

	{#if form?.failed?.length}
		<section class="card alarm">
			<h2>{form.failed.length} not invited</h2>
			<ul class="failed">
				{#each form.failed as failure (failure.username)}
					<li><span class="mono">{failure.username}</span> — {failure.reason}</li>
				{/each}
			</ul>
		</section>
	{/if}

	<form
		method="POST"
		action="?/invite"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update({ reset: false });
				busy = false;
			};
		}}
	>
		<label>
			One per line. <span class="dim">username</span>, or
			<span class="dim">username, Display Name</span>, or
			<span class="dim">username, Display Name, email</span>
			<textarea
				name="roster"
				bind:value={roster}
				rows="10"
				spellcheck="false"
				autocapitalize="none"
				placeholder="cheyenne, Cheyenne S&#10;josie, Josie D&#10;nick, Nick S"></textarea>
		</label>

		<label class="single">
			<input type="checkbox" name="singleUse" />
			<span>
				Single-use links
				<span class="dim small">
					Off by default on purpose. A single-use link is consumed the moment anything opens it,
					including the preview your messaging app fetches, so texting them mostly ends with dead
					links. Turn this on only if you are handing the link over in person.
				</span>
			</span>
		</label>

		<label class="days">
			Links expire after
			<input
				name="days"
				type="number"
				min="1"
				max="30"
				value={data.defaultDays}
				inputmode="numeric"
			/>
			days
		</label>

		<button class="submit" type="submit" disabled={busy || lineCount === 0 || data.gate.blocked}>
			{busy
				? "Creating…"
				: lineCount === 0
					? "Nobody listed yet"
					: `Create ${String(lineCount)} invitation${lineCount === 1 ? "" : "s"}`}
		</button>
	</form>

	<details>
		<summary>Accounts that already exist ({data.existing.length})</summary>
		<p class="mono small dim">{data.existing.join("  ")}</p>
		<p class="small dim">Anyone on this list is skipped rather than invited twice.</p>
	</details>
</main>

<style>
	main {
		max-width: 34rem;
		margin: 0 auto;
		padding: 1rem 1rem 5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.back {
		align-self: flex-start;
		color: var(--accent);
		text-decoration: none;
		padding: 0.5rem 0;
	}
	header {
		border-bottom: 2px solid var(--ink);
		padding-bottom: 0.7rem;
	}
	h1 {
		margin: 0;
		font-size: 1.5rem;
	}
	h2 {
		margin: 0;
		font-size: 1rem;
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--rule);
		border-radius: 4px;
		padding: 0.85rem 1rem;
	}
	.card p {
		margin: 0.3rem 0 0;
		font-size: 0.9rem;
	}
	.card.alarm {
		background: var(--danger-soft);
		border-color: var(--danger);
	}
	.card.ok {
		background: var(--ok-soft);
		border-color: var(--ok);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.88rem;
	}
	textarea {
		font-family: var(--mono);
		font-size: 0.9rem;
		padding: 0.6rem;
		background: var(--surface);
		color: var(--ink);
		border: 1px solid var(--rule);
		border-radius: 4px;
		resize: vertical;
	}
	.single {
		flex-direction: row;
		align-items: flex-start;
		gap: 0.55rem;
	}
	.single input {
		margin-top: 0.15rem;
		width: 1.15rem;
		height: 1.15rem;
		flex: none;
	}
	.single span {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.days {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}
	.days input {
		width: 5rem;
		min-height: 2.75rem;
		padding: 0 0.6rem;
		font: inherit;
		background: var(--surface);
		color: var(--ink);
		border: 1px solid var(--rule);
		border-radius: 4px;
	}
	textarea:focus-visible,
	input:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	button {
		font: inherit;
		border-radius: 4px;
		border: 1px solid var(--rule);
		background: var(--surface);
		color: var(--ink);
		min-height: 2.5rem;
		padding: 0 0.8rem;
	}
	button.submit {
		min-height: 3rem;
		font-weight: 600;
		color: var(--paper);
		background: var(--ink);
		border: 0;
	}
	button.submit:disabled {
		opacity: 0.4;
	}
	button.copyAll {
		margin-top: 0.6rem;
	}
	ul.links {
		list-style: none;
		margin: 0.7rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	ul.links li {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding-top: 0.6rem;
		border-top: 1px solid var(--rule);
	}
	.who {
		font-weight: 600;
	}
	.link {
		font-size: 0.72rem;
		word-break: break-all;
		color: var(--ink-2);
	}
	ul.failed {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
		font-size: 0.88rem;
	}
	details summary {
		cursor: pointer;
		font-size: 0.9rem;
	}
	.mono {
		font-family: var(--mono);
		word-break: break-word;
	}
	.small {
		font-size: 0.82rem;
	}
	.dim {
		color: var(--ink-3);
	}
</style>
