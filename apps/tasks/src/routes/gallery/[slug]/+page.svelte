<script>
	import ArtifactView from "./ArtifactView.svelte";

	let { data } = $props();
</script>

<!-- SvelteKit reuses this page when a link goes to another artifact; the key gives each
     artifact a fresh view, so frame sizing and pencil ink never carry over between slugs. -->
{#key data.slug}
	<ArtifactView {data} />
{/key}
