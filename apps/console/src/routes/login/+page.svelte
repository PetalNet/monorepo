<script lang="ts">
	import { authClient } from "$lib/auth-client";

	const signIn = () => authClient.signIn.oauth2({ providerId: "authentik", callbackURL: "/" });
</script>

<svelte:head><title>Sign in · Lab Console</title></svelte:head>

<main>
	<h1>Lab Console</h1>
	<p>Sign in through Authentik to continue.</p>
	<button onclick={signIn}>Sign in with Authentik</button>
</main>
