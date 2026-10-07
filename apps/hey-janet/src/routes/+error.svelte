<script lang="ts">
	import { resolve } from "$app/paths";
	import { page } from "$app/state";
</script>

<svelte:head><title>Let’s try again · Hey Janet</title></svelte:head>
<main class="shell">
	<a class="brand" href={resolve("/")}>Hey Janet</a>
	<section class="intro">
		<h1>{page.status === 403 ? "This part is for Parker." : "We couldn’t finish that."}</h1>
		<p>
			{page.error?.message ?? "Please try again. Your accepted takes remain saved on your device."}
		</p>
		<div class="row">
			<a class="button" href={resolve("/")}>Return to the booth</a>{#if page.status === 403}<a
					class="button secondary"
					href={resolve("/auth/login")}>Sign in with PetalNet</a
				>{/if}
		</div>
	</section>
</main>
