<script lang="ts">
	import { authClient } from "$lib/auth-client";
	let { data, form } = $props();

	const signIn = () => authClient.signIn.oauth2({ providerId: "oidc", callbackURL: "/login" });
</script>

<svelte:head><title>Sign in · Lab Console</title></svelte:head>

<main>
	<h1>Lab Console</h1>
	{#if data.authenticated}
		<p>Enter the one-time first-run code from the server log to become the owner.</p>
		<form method="POST" action="?/claim">
			<label for="code">Admin claim code</label>
			<input id="code" name="code" required autocomplete="off" />
			<button>Claim ownership</button>
		</form>
		{#if form?.invalid}<p>That claim code is invalid or has already been used.</p>{/if}
	{:else}
		<p>Sign in through the configured SSO provider to continue.</p>
		<button onclick={signIn}>Sign in with SSO</button>
	{/if}
</main>
