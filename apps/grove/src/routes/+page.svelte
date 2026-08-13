<script lang="ts">
	import GroveDashboard from "$lib/components/GroveDashboard.svelte";
	import LogIn from "@lucide/svelte/icons/log-in";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";

	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
	const ownerUnbound = $derived(data.readiness.status === "owner-unbound");
</script>

<svelte:head><title>Grove transport demo</title></svelte:head>

{#if data.actor}
	<GroveDashboard />
{:else}
	<main class="mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-12 sm:py-20">
		<div class="w-full">
			<p class="text-primary text-xs font-bold tracking-[0.12em] uppercase">Effect domain demo</p>
			<h1 class="mt-1 max-w-2xl text-5xl font-bold tracking-tight sm:text-7xl">Grove sprouts</h1>
			<p class="text-base-content/70 mt-4 max-w-2xl leading-relaxed">
				Grove runs every browser, REST, and MCP action through the same actor-aware command plane.
			</p>

			<section class="bg-base-200 mt-8 p-6 sm:p-8" aria-labelledby="access-heading">
				<ShieldCheck aria-hidden={true} class="text-primary size-8" strokeWidth={1.75} />
				<h2 id="access-heading" class="mt-4 text-2xl font-semibold">
					{ownerUnbound ? "Home Host owner required" : "Sign in to continue"}
				</h2>
				<p class="text-base-content/70 mt-2 max-w-xl leading-relaxed">
					{ownerUnbound
						? "The operator-pinned owner must complete the first verified OIDC sign-in before actor-protected operations become available."
						: "Use your verified browser identity to enter Grove. Domain operations remain unavailable until the request has a current Person actor."}
				</p>
				<div class="mt-6 flex flex-wrap gap-3">
					<a class="btn btn-primary" href="/login">
						<LogIn aria-hidden={true} class="size-4" />
						Sign in with OIDC
					</a>
					<a class="btn btn-ghost" href="/api/readiness">View readiness</a>
				</div>
			</section>
		</div>
	</main>
{/if}
