<script lang="ts">
	import { currentAccount } from "#lib/account.remote.ts";

	import SignOutForm from "./SignOutForm.svelte";
	import ThemeToggle from "./ThemeToggle.svelte";

	const account = currentAccount();
	const user = $derived(
		await account.then(
			(value) => value,
			() => account.current,
		),
	);
</script>

<details class="dropdown dropdown-end">
	<summary class="btn btn-ghost flex max-w-full gap-2" aria-label="Account menu">
		{#if user}<span class="avatar avatar-placeholder" aria-hidden="true">
				<span class="bg-base-200 text-base-content w-8 rounded-full">
					<span>{user.name.slice(0, 1).toUpperCase()}</span>
				</span>
			</span>{/if}
		<span class={["max-w-40 truncate", user && "hidden sm:block"]}>{user?.name ?? "Account"}</span>
	</summary>
	<div
		class="dropdown-content bg-base-100 text-base-content z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-sm p-2 shadow-md"
	>
		{#if user}
			<div class="px-2 py-4">
				<p class="font-medium break-words">{user.name}</p>
				<p class="text-sm break-all">{user.email}</p>
			</div>
		{/if}
		{#if account.error}<p class="text-error px-2 py-4" role="alert">
				Account details are unavailable. Open settings to try again.
			</p>{/if}
		<ul class="menu w-full p-0">
			<li><a href="/settings">Account settings</a></li>
		</ul>
		<div class="flex items-center justify-between px-2 py-2">
			<span class="text-sm">Appearance</span><ThemeToggle />
		</div>
		<SignOutForm />
	</div>
</details>
