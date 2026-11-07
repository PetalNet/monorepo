<script lang="ts">
	import { editor } from "./editor.svelte";
	import Inspector from "./Inspector.svelte";
	import LabelSettings from "./LabelSettings.svelte";
</script>

{#if editor.selection.length > 0}
	<Inspector />
{:else}
	<LabelSettings />
{/if}
