<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import LabPlate from "$lib/components/LabPlate.svelte";
	import Orloj from "$lib/components/Orloj.svelte";
	import ThemeToggle from "$lib/components/ThemeToggle.svelte";
	import { onMount } from "svelte";

	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();

	onMount(() => {
		const interval = window.setInterval(() => void invalidateAll(), 30_000);

		return () => {
			window.clearInterval(interval);
		};
	});
</script>

<svelte:head
	><title>Astrolabe</title><meta name="description" content="Lab status dashboard" /></svelte:head
>

<header class="top">
	<div class="top-inner">
		<h1>Astrolabe</h1>
		<ThemeToggle />
	</div>
</header>

<main class="wrap">
	<Orloj dossier={data.dossier} />

	<LabPlate dossier={data.dossier} />
</main>
