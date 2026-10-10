<script lang="ts">
	import AgentPermissions from "#lib/components/AgentPermissions.svelte";
</script>

<svelte:head><title>Agent permissions · Grove</title></svelte:head>

<main class="mx-auto w-full max-w-xl px-4 py-8 sm:px-8">
	<a class="link" href="/settings">Back to settings</a>
	<h1 class="mt-8 mb-8 text-2xl font-medium">Agent permissions</h1>
	<AgentPermissions />
</main>
