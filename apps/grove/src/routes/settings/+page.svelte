<script lang="ts">
	import { page } from "$app/state";

	import { currentAccount, updateAccount } from "#lib/account.remote.ts";
	import SignOutForm from "#lib/components/SignOutForm.svelte";
	import ThemeToggle from "#lib/components/ThemeToggle.svelte";

	const account = currentAccount();
	const user = $derived(
		await account.then(
			(value) => value,
			() => account.current,
		),
	);
	const accountForm = updateAccount;
	let failure = $state("");
	let saved = $state(false);
</script>

<svelte:head><title>Account settings · Grove</title></svelte:head>

<main class="mx-auto w-full max-w-xl px-4 py-8 sm:px-8">
	<a class="link" href="/">Back to console</a>
	<h1 class="mt-8 mb-8 text-2xl font-medium">Account settings</h1>
	{#if account.error}<div class="mb-4 flex flex-wrap items-center gap-4">
			<p class="text-error" role="alert">
				{user
					? "Could not refresh account details. Your edits are still here."
					: "Could not load account details."}
			</p>
			<a
				class="btn btn-ghost"
				href={page.url.href}
				onclick={(event) => {
					event.preventDefault();
					void account.refresh().catch(() => undefined);
				}}
				aria-disabled={account.loading}>{account.loading ? "Loading…" : "Try again"}</a
			>
		</div>{/if}
	{#if user}
		<form
			class="grid gap-4"
			{...accountForm.enhance(async (form) => {
				failure = "";
				saved = false;
				const name = form.fields.name.value()?.trim() ?? "";

				try {
					const result = await form
						.submit()
						.updates(account.withOverride((current) => ({ ...current, name })));

					saved = result;
				} catch (cause) {
					failure = cause instanceof Error ? cause.message : "Could not save your name. Try again.";
				}
			})}
			aria-busy={accountForm.pending > 0}
		>
			<label class="fieldset">
				<span class="fieldset-legend">Name</span>
				<input
					class="input w-full"
					{...accountForm.fields.name.as("text")}
					value={user.name}
					required
					maxlength="80"
					autocomplete="name"
					aria-describedby="name-issues"
				/>
				<span id="name-issues" class="text-error text-sm">
					{#each accountForm.fields.name.issues() ?? [] as issue, index (index)}<span class="block"
							>{issue.message}</span
						>{/each}
				</span>
			</label>
			<label class="fieldset">
				<span class="fieldset-legend">Email</span>
				<input class="input w-full" type="email" value={user.email} readonly autocomplete="email" />
			</label>
			<div class="flex flex-wrap items-center gap-4">
				<button class="btn btn-primary" disabled={accountForm.pending > 0}
					>{accountForm.pending > 0 ? "Saving…" : "Save name"}</button
				>
				<p role="status">{saved || accountForm.result?.saved ? "Name saved." : ""}</p>
			</div>
			{#if failure}<p class="text-error" role="alert">{failure}</p>{/if}
		</form>
	{:else if account.loading}<p role="status">Loading account details…</p>{/if}
	<div class="mt-8 flex items-center justify-between py-4">
		<h2 class="font-medium">Appearance</h2>
		<ThemeToggle />
	</div>
	<div class="py-4"><a class="link" href="/settings/agents">Agent permissions</a></div>
	<div class="mt-4"><SignOutForm /></div>
</main>
