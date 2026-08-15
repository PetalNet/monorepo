<script lang="ts">
	import { dev } from "$app/env";
	import Moon from "@lucide/svelte/icons/moon";
	import Sun from "@lucide/svelte/icons/sun";
	import { ModeWatcher } from "mode-watcher";
	import { onMount, type Snippet } from "svelte";

	import favicon from "#lib/assets/favicon.svg";
	import { Theme } from "#lib/theme.svelte.ts";

	import "../app.css";

	import type { LayoutData } from "./$types";

	let { children, data }: { children: Snippet; data: LayoutData } = $props();
	const theme = new Theme();
	onMount(() => {
		if (!dev || !data.devBrowserLogs) return;
		let disposed = false;
		let remove: (() => void) | undefined;
		void import("#lib/dev-browser-logs.ts").then(({ installDevBrowserLogs }) => {
			const installed = installDevBrowserLogs();
			if (disposed) installed();
			else remove = installed;
			return undefined;
		});
		return () => {
			disposed = true;
			remove?.();
		};
	});
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
