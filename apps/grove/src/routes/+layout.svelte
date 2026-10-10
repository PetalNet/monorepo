<script lang="ts">
	import { ModeWatcher } from "mode-watcher";
	import { onMount, type Snippet } from "svelte";

	import favicon from "#lib/assets/favicon.svg";

	import "../app.css";

	import type { LayoutData } from "./$types";

	let { children, data }: { children: Snippet; data: LayoutData } = $props();
	onMount(() => {
		if (!import.meta.env.DEV || !data.devBrowserLogs) {
			return;
		}

		let disposed = false;
		let remove: (() => void) | undefined;

		void import("#lib/dev/browser-logs.ts").then(({ installDevBrowserLogs }) => {
			const installed = installDevBrowserLogs();

			if (disposed) {
				installed();
			} else {
				remove = installed;
			}

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

{@render children()}
