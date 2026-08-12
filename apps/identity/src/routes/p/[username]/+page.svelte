<script lang="ts">
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	import type { ActionData, PageData } from "./$types";

	const { data, form }: { data: PageData; form: ActionData } = $props();

	/** Which role's impact panel is open. Only one at a time on a phone. */
	let open = $state<string | null>(null);
	let confirmText = $state("");
	let busy = $state<string | null>(null);

	const toggle = (roleId: string) => {
		open = open === roleId ? null : roleId;
		confirmText = "";
	};
</script>

<svelte:head><title>{data.person.displayName} · PetalNet Identity</title></svelte:head>

<main>
	<a class="back" href={resolve("/")}>Back</a>

	<header>
		<h1>{data.person.displayName}</h1>
		<p class="handle">{data.person.username}{#if data.person.email} · {data.person.email}{/if}</p>
		<p class="roles">{data.person.roleIds.join(" · ") || "no roles"}</p>
	</header>

	{#if form?.message}
		<div class="banner bad" role="alert">{form.message}</div>
	{:else if form?.applied}
		<div class="banner" class:good={form.verified} class:bad={!form.verified} role="status">
			<strong>{form.verified ? "Verified" : "Applied but NOT verified"}</strong>
			<p>{form.roleId} {form.action}.</p>
			<ul class="checks">
				{#each form.verifications as check (check.resourceId)}
					<li class:fail={!check.passed}>
						{check.passed ? "✓" : "✗"}
						{check.resourceId}
						<span class="dim">expected {check.expected}, got {check.observed}</span>
					</li>
				{/each}
			</ul>
			{#if !form.verified}
				<p class="dim">
					The write went through but at least one check did not match. Treat access as
					unknown until this is understood.
				</p>
			{/if}
		</div>
	{/if}

	<h2>Roles</h2>
	<ul class="roleList">
		{#each data.roles as role (role.roleId)}
			{@const changes = role.impact.gains.length + role.impact.loses.length}
			<li>
				<button
					class="roleRow"
					class:held={role.held}
					aria-expanded={open === role.roleId}
					onclick={() => {
						toggle(role.roleId);
					}}
				>
					<span class="check" aria-hidden="true">{role.held ? "✓" : ""}</span>
					<span class="roleName">{role.name}</span>
					<span class="delta" class:none={changes === 0}>
						{#if changes === 0}
							no change
						{:else if role.held}
							−{role.impact.loses.length}
						{:else}
							+{role.impact.gains.length}
						{/if}
					</span>
				</button>

				{#if open === role.roleId}
					<div class="panel">
						{#if role.level === "dangerous"}
							<p class="warn">High impact. This touches sensitive applications or many at once.</p>
						{/if}

						{#if role.impact.gains.length}
							<div class="group">
								<span class="label gain">Gains</span>
								<p>{role.impact.gains.join(", ")}</p>
							</div>
						{/if}
						{#if role.impact.loses.length}
							<div class="group">
								<span class="label lose">Loses</span>
								<p>{role.impact.loses.join(", ")}</p>
							</div>
						{/if}
						{#if role.impact.keeps.length}
							<div class="group">
								<span class="label">Keeps</span>
								<p class="dim">{role.impact.keeps.join(", ")}</p>
							</div>
						{/if}
						{#if changes === 0}
							<p class="dim">Nothing would change. They already have what this role grants.</p>
						{/if}

						<form
							method="POST"
							action="?/toggleRole"
							use:enhance={() => {
								busy = role.roleId;
								return async ({ update }) => {
									await update();
									busy = null;
									open = null;
									confirmText = "";
								};
							}}
						>
							<input type="hidden" name="roleId" value={role.roleId} />
							<input type="hidden" name="held" value={String(role.held)} />

							{#if role.level === "dangerous"}
								<label class="confirm">
									Type <strong>{data.person.username}</strong> to confirm
									<input
										name="confirm"
										bind:value={confirmText}
										autocomplete="off"
										autocapitalize="none"
										spellcheck="false"
									/>
								</label>
							{/if}

							<button
								class="apply"
								class:danger={role.level === "dangerous"}
								type="submit"
								disabled={busy !== null ||
									changes === 0 ||
									(role.level === "dangerous" && confirmText !== data.person.username)}
							>
								{busy === role.roleId
									? "Applying and verifying…"
									: role.held
										? `Remove ${role.name} & verify`
										: `Add ${role.name} & verify`}
							</button>
						</form>
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	{#if data.person.unmappedGroups.length}
		<h2>Other Authentik groups</h2>
		<p class="dim small">
			Groups this tool has no role for. Shown rather than hidden, because a group nobody models
			is exactly the sort of thing that turns out to grant something.
		</p>
		<p class="mono dim">{data.person.unmappedGroups.join("  ")}</p>
	{/if}
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
		font-size: 0.95rem;
	}
	header {
		border-bottom: 2px solid var(--ink);
		padding-bottom: 0.75rem;
	}
	h1 {
		margin: 0;
		font-size: 1.6rem;
		letter-spacing: -0.01em;
	}
	h2 {
		margin: 0.5rem 0 0;
		font-size: 1rem;
	}
	.handle,
	.roles {
		margin: 0.15rem 0 0;
		font-size: 0.9rem;
		color: var(--ink-3);
	}
	.roles {
		color: var(--ink-2);
	}
	.banner {
		border-radius: 4px;
		padding: 0.85rem 1rem;
		border: 1px solid var(--rule);
	}
	.banner.good {
		background: var(--ok-soft);
		border-color: var(--ok);
	}
	.banner.bad {
		background: var(--danger-soft);
		border-color: var(--danger);
	}
	.banner p {
		margin: 0.3rem 0 0;
		font-size: 0.9rem;
	}
	ul.checks {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
		font-family: var(--mono);
		font-size: 0.8rem;
	}
	ul.checks li.fail {
		color: var(--danger);
		font-weight: 600;
	}
	ul.roleList {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.roleRow {
		width: 100%;
		display: grid;
		grid-template-columns: 1.75rem 1fr auto;
		align-items: center;
		gap: 0.5rem;
		/* Thumb-sized. Anything under about 44px is a mis-tap waiting to happen. */
		min-height: 3.25rem;
		padding: 0 0.9rem;
		font: inherit;
		text-align: left;
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--rule);
		border-radius: 4px;
	}
	.roleRow.held {
		border-color: var(--ok);
	}
	.roleRow:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.check {
		color: var(--ok);
		font-weight: 700;
	}
	.roleName {
		font-weight: 600;
	}
	.delta {
		font-family: var(--mono);
		font-size: 0.85rem;
		color: var(--accent);
	}
	.delta.none {
		color: var(--ink-3);
	}
	.panel {
		border: 1px solid var(--rule);
		border-top: 0;
		border-radius: 0 0 4px 4px;
		padding: 0.85rem 0.9rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.group p {
		margin: 0.1rem 0 0;
		font-size: 0.88rem;
		word-break: break-word;
	}
	.label {
		font-family: var(--mono);
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-3);
	}
	.label.gain {
		color: var(--ok);
	}
	.label.lose {
		color: var(--danger);
	}
	.warn {
		margin: 0;
		color: var(--danger);
		font-size: 0.88rem;
		font-weight: 600;
	}
	.confirm {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
	}
	.confirm input {
		min-height: 2.75rem;
		padding: 0 0.7rem;
		font: inherit;
		background: var(--paper);
		color: var(--ink);
		border: 1px solid var(--rule);
		border-radius: 4px;
	}
	button.apply {
		min-height: 3rem;
		font: inherit;
		font-weight: 600;
		color: var(--paper);
		background: var(--ink);
		border: 0;
		border-radius: 4px;
	}
	button.apply.danger {
		background: var(--danger);
		color: #fff;
	}
	button.apply:disabled {
		opacity: 0.4;
	}
	.dim {
		color: var(--ink-3);
	}
	.small {
		font-size: 0.82rem;
	}
	.mono {
		font-family: var(--mono);
		font-size: 0.8rem;
		word-break: break-word;
	}
</style>
