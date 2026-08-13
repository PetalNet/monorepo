<script lang="ts">
	import Moon from "@lucide/svelte/icons/moon";
	import Sun from "@lucide/svelte/icons/sun";
	import { ModeWatcher } from "mode-watcher";
	import { onMount, type Snippet } from "svelte";

	import favicon from "#lib/assets/favicon.svg";
	import { installDevBrowserLogs } from "#lib/dev-browser-logs.ts";
	import { Theme } from "#lib/theme.svelte.ts";

	import "../app.css";

	import type { LayoutData } from "./$types";

	let { children, data }: { children: Snippet; data: LayoutData } = $props();
	const theme = new Theme();
	onMount(() => (data.devBrowserLogs ? installDevBrowserLogs() : undefined));
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<ModeWatcher synchronousModeChanges />

<label class="text-base-content fixed top-4 right-4 z-50 flex cursor-pointer items-center gap-2">
	<Sun aria-hidden={true} class="size-5" />
	<input
		type="checkbox"
		class="toggle"
		checked={theme.dark}
		onclick={(event) => {
			event.preventDefault();
			theme.toggle();
		}}
		aria-label="Toggle color scheme"
	/>
	<Moon aria-hidden={true} class="size-5" />
</label>

{@render children()}
