<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Lab Console</title></svelte:head>

<main>
	<p>Authenticated as {data.user.name}</p>
	<h1>Console foundation</h1>
	<p>The SvelteKit and Effect service boundary is ready.</p>
</main>
