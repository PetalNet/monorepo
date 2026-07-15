<script lang="ts">
	import type { PageProps } from "./$types";
	let { data }: PageProps = $props();
</script>

<svelte:head><title>Lab Console</title></svelte:head>

<main class="mx-auto max-w-3xl p-8 lg:p-16">
	<div class="card border border-base-300 bg-base-200 shadow-lg">
		<div class="card-body">
			<p class="text-sm font-medium text-primary">Authenticated as {data.user.name}</p>
			<h1 class="card-title text-3xl">Console foundation</h1>
			<p class="text-base-content/70">The SvelteKit and Effect service boundary is ready.</p>
		</div>
	</div>
</main>
