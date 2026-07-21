<script lang="ts">
	import { authClient } from "$lib/auth-client";
	import { LogIn, ShieldCheck } from "@lucide/svelte";
	import type { PageProps } from "./$types";
	let { data, form }: PageProps = $props();

	const signIn = () => authClient.signIn.social({ provider: "oidc", callbackURL: "/login" });
</script>

<svelte:head><title>Sign in · Lab Console</title></svelte:head>

<main class="grid min-h-screen place-items-center p-6">
	<section class="card w-full max-w-md border border-base-300 bg-base-200 shadow-xl">
		<div class="card-body gap-6">
			<div class="flex items-center gap-3 text-primary">
				<ShieldCheck size={28} strokeWidth={1.8} />
				<p class="text-sm font-semibold tracking-[0.18em] uppercase">Lab Console</p>
			</div>
			<h1 class="text-3xl font-semibold tracking-tight">Welcome back</h1>
	{#if data.authenticated}
		<p class="text-base-content/70">Enter the one-time first-run code from the server log to become the owner.</p>
		<form method="POST" action="?/claim" class="grid gap-3">
			<label class="label" for="code">Admin claim code</label>
			<input class="input input-bordered w-full" id="code" name="code" required autocomplete="off" />
			<button class="btn btn-primary mt-2">Claim ownership</button>
		</form>
		{#if form?.invalid}<p class="alert alert-error">That claim code is invalid or has already been used.</p>{/if}
	{:else}
		<p class="text-base-content/70">Sign in through the configured SSO provider to continue.</p>
		<button class="btn btn-primary w-full" onclick={signIn}><LogIn size={18} /> Sign in with SSO</button>
	{/if}
		</div>
	</section>
</main>
