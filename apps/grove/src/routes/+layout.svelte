<script lang="ts">
	import { ModeWatcher } from "mode-watcher";

	import favicon from "#lib/assets/favicon.svg";

	import "../app.css";

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<ModeWatcher defaultMode="system" disableTransitions />

{@render children()}
