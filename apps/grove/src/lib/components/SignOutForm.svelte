<script lang="ts">
	import { signOut } from "#lib/account.remote.ts";

	let failure = $state("");
</script>

<form
	{...signOut.enhance(async ({ submit }) => {
		failure = "";

		try {
			await submit();
		} catch {
			failure = "Could not sign out. Try again.";
		}
	})}
	aria-busy={signOut.pending > 0}
>
	<button class="btn btn-ghost" disabled={signOut.pending > 0}
		>{signOut.pending > 0 ? "Signing out…" : "Sign out"}</button
	>
	{#if failure}<p class="text-error" role="alert">{failure}</p>{/if}
</form>
