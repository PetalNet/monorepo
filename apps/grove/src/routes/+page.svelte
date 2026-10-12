<script lang="ts">
	import LogIn from "@lucide/svelte/icons/log-in";

	import GroveConsole from "#lib/components/GroveConsole.svelte";

	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
	const ownerUnbound = $derived(data.readiness.status === "owner-unbound");
</script>

<svelte:head><title>Grove · Lab console</title></svelte:head>

{#if data.actor}
	<GroveConsole />
{:else}
	<main class="grid min-h-dvh place-items-center px-4 py-8">
		<section class="card bg-base-100 w-full max-w-sm" aria-labelledby="signin-heading">
			<div class="card-body gap-6 p-8">
				<h1 id="signin-heading" class="text-2xl font-normal">Sign in to Grove</h1>
				{#if ownerUnbound}<p>The configured owner must sign in first.</p>{/if}
				<a class="btn btn-primary" href="/login" data-sveltekit-reload>
					<LogIn aria-hidden={true} size={16} />Sign in
				</a>
			</div>
		</section>
	</main>
{/if}
