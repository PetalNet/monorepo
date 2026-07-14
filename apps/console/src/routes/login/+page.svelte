<script lang="ts">
	import { page } from "$app/state";
	import { authClient } from "$lib/auth-client";
	import { captureCaughtFailure } from "$lib/glitchtip";

	let pending = $state(false);
	let failed = $state(false);

	async function signIn() {
		pending = true;
		failed = false;
		try {
			const returnTo = page.url.searchParams.get("returnTo");
			const callbackURL = returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
			const result = await authClient.signIn.oauth2({ providerId: "authentik", callbackURL, errorCallbackURL: "/login?error=oidc" });
			if (result.error) throw new Error(result.error.message ?? "Authentik sign-in failed");
		} catch (error) {
			captureCaughtFailure(error, { surface: "console-login", endpoint: "/api/auth/sign-in/oauth2" });
			failed = true;
			pending = false;
		}
	}
</script>

<svelte:head><title>Sign in · Lab Console</title></svelte:head>

<main class="login-shell">
	<section aria-labelledby="login-title">
		<p class="place">Neighborhood 12358W</p>
		<h1 id="login-title">Lab Console</h1>
		<p class="purpose">Sign in with PetalNet SSO to see the systems and scopes granted to you.</p>
		<button type="button" onclick={signIn} disabled={pending} aria-describedby="sso-note">
			{pending ? "Opening PetalNet SSO…" : "Continue with PetalNet SSO"}
		</button>
		<p id="sso-note" class="note">Authentication is handled by Authentik. Lab Console stores only its own session.</p>
		{#if failed || page.url.searchParams.has("error")}<p class="error" role="alert">Sign-in couldn't be completed. Please try again.</p>{/if}
	</section>
</main>

<style>
	.login-shell { min-height: 100dvh; display: grid; place-items: center; padding: var(--s-4); background: var(--bg); color: var(--text); }
	section { width: min(100%, 440px); padding: var(--s-5); background: var(--s1); border-radius: var(--r-xs); }
	.place { margin: 0 0 var(--s-2); color: var(--jade); font: 500 .75rem var(--mono); }
	h1 { margin: 0; font: 400 2rem/1.15 var(--sign); letter-spacing: -.012em; text-wrap: balance; }
	.purpose { max-width: 44ch; margin: var(--s-3) 0 var(--s-4); color: var(--text-2); text-wrap: pretty; }
	button { width: 100%; min-height: 44px; border: 0; border-radius: var(--r-sm); background: var(--petal-fill); color: var(--on-petal); font: 500 .875rem var(--sans); cursor: pointer; transition: filter 140ms ease-out; }
	button:hover:not(:disabled) { filter: brightness(.92); }
	button:focus-visible { outline: 2px solid var(--petal); outline-offset: 3px; }
	button:disabled { cursor: wait; opacity: .7; }
	.note, .error { margin: var(--s-3) 0 0; font-size: .75rem; line-height: 1.55; }
	.note { color: var(--text-3); }
	.error { padding: var(--s-2); background: var(--danger-soft); color: var(--danger-text); border-radius: var(--r-xs); }
	@media (max-width: 520px) { section { padding: var(--s-4); } }
	@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
