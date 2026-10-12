<script lang="ts">
	import AccountMenu from "#lib/components/AccountMenu.svelte";
	import ProjectCreateForm from "#lib/components/ProjectCreateForm.svelte";
</script>

<svelte:head><title>New project · Grove</title></svelte:head>
<main class="mx-auto max-w-2xl px-4 py-8 sm:px-8">
	<header class="mb-8 flex items-center justify-between gap-4">
		<a class="link" href="/">Back to work</a><AccountMenu />
	</header>
	<h1 class="mb-8 text-2xl font-normal">New project</h1>
	<ProjectCreateForm />
</main>
