<script lang="ts">
	let { name = "PetalNet" }: { name?: string } = $props();
</script>

<main>
	<h1>Welcome to {name} Storybook</h1>
	<p>Add stories to this app to develop components in isolation.</p>
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		padding: 2rem;
	}

	h1 {
		margin-block: 0 0.5rem;
	}

	p {
		color: #475569;
		margin: 0;
	}
</style>
