<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import LabPlate from "$lib/components/LabPlate.svelte";
	import Orloj from "$lib/components/Orloj.svelte";
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

<main class="wrap">
	<h1 class="sr-only">Astrolabe</h1>
	<Orloj dossier={data.dossier} />

	<LabPlate dossier={data.dossier} />
</main>
