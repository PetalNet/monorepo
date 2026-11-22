<script lang="ts">
	import { page } from "$app/state";

	import RecoveryForm from "#lib/components/RecoveryForm.svelte";
	let token = $derived(page.url.searchParams.get("token") ?? "");
</script>

<svelte:head
	><title>Restore your collection · Petal Relics</title><meta
		name="referrer"
		content="no-referrer"
	/></svelte:head
><RecoveryForm kind="restore" {token} />
