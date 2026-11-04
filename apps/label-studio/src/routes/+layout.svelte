<script lang="ts">
	import "../app.css";
	import { resolve } from "$app/paths";
	import { page } from "$app/state";
	import { editor } from "$lib/editor/editor.svelte";
	import { chrome } from "$lib/ui/chrome.svelte";
	import JobRow from "$lib/ui/JobRow.svelte";
	import { jobs } from "$lib/ui/jobs.svelte";
	import { printerStatus } from "$lib/ui/printer.svelte";
	import PrinterSheet from "$lib/ui/PrinterSheet.svelte";
	import StatusPill from "$lib/ui/StatusPill.svelte";
	import { History, LayoutGrid, PenTool, Rows3 } from "@lucide/svelte";
	import type { Snippet } from "svelte";

	let { children }: { children: Snippet } = $props();

	let printerOpen = $state(false);

	const sections = [
		{ href: "/", label: "Editor", icon: PenTool },
		{ href: "/templates", label: "Templates", icon: LayoutGrid },
		{ href: "/batch", label: "Batch", icon: Rows3 },
		{ href: "/history", label: "History", icon: History },
	] as const;

	const active = (href: string): boolean =>
		href === "/" ? page.url.pathname === "/" : page.url.pathname.startsWith(href);

	editor.restore();
	printerStatus.start();

	// Follow the loaded cassette unless the user chose a width by hand.
	$effect(() => {
		const loaded = printerStatus.loadedTape;

		if (loaded !== null && !editor.tapePinned && loaded !== editor.doc.tapeMm) {
			editor.setTape(loaded, false);
		}
	});
</script>

<svelte:head>
	<title>Label Studio</title>
</svelte:head>

<div class="shell" style:--banner-h={jobs.current ? "64px" : "0px"}>
	<header class="bar">
		<a class="mark" href={resolve("/")} aria-label="Label Studio, editor">
			<span class="glyph" aria-hidden="true"></span>
			<span class="word">Label Studio</span>
		</a>
		<nav class="tabs" aria-label="Sections">
			{#each sections as section (section.href)}
				<a href={resolve(section.href)} aria-current={active(section.href) ? "page" : undefined}
					>{section.label}</a
				>
			{/each}
		</nav>
		<div class="end">
			<StatusPill onclick={() => (printerOpen = true)} />
			{#if chrome.actions}{@render chrome.actions()}{/if}
		</div>
	</header>

	{#if jobs.current}
		<div class="job-banner">
			<JobRow entry={jobs.current} />
		</div>
	{/if}

	<main>{@render children()}</main>

	<nav class="tabbar" aria-label="Sections">
		{#each sections as section (section.href)}
			<a href={resolve(section.href)} aria-current={active(section.href) ? "page" : undefined}>
				<section.icon aria-hidden="true" />
				<span>{section.label}</span>
			</a>
		{/each}
	</nav>
</div>

<PrinterSheet bind:open={printerOpen} />

<style>
	/* The document scrolls, so the browser restores each page's scroll position and mobile toolbars collapse. */
	.shell {
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
	}

	.bar {
		position: sticky;
		top: 0;
		z-index: 4;
		flex: none;
		height: var(--bar-h);
		display: flex;
		align-items: center;
		gap: 24px;
		padding-inline: 16px;
		padding-top: env(safe-area-inset-top);
		background: var(--panel);
		box-shadow: 0 1px 0 var(--rule);
	}

	.mark {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
	}

	/* A length of tape cut to a flag tail, its two lines of print knocked out: the product's own
	   object as its mark, in the accent. */
	.glyph {
		width: 28px;
		height: 16px;
		background: var(--accent);
		mask: url("../lib/ui/mark.svg") center / contain no-repeat;
	}

	.tabs {
		display: flex;
		gap: 2px;
	}

	.tabs a {
		position: relative;
		padding: 6px 10px;
		border-radius: var(--r);
		color: var(--ink-2);
		font-weight: 500;
		text-decoration: none;
		transition:
			color var(--fast),
			background-color var(--fast);
	}

	.tabs a:hover {
		background: var(--hover);
		color: var(--ink);
	}

	.tabs a[aria-current="page"] {
		color: var(--ink);
	}

	.tabs a[aria-current="page"]::after {
		content: "";
		position: absolute;
		inset-inline: 10px;
		bottom: -12px;
		height: 2px;
		background: var(--ink);
		animation: grow var(--base) var(--ease);
	}

	.end {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-inline-start: auto;
	}

	main {
		flex: 1;
		min-height: 0;
	}

	/* The job status sits in the page flow under the bar: persistent, never floating over work. */
	.job-banner {
		position: sticky;
		top: var(--bar-h);
		z-index: 3;
		display: flex;
		align-items: center;
		height: var(--banner-h);
		padding: 6px 12px;
		background: var(--ground);
		box-shadow: 0 1px 0 var(--rule);
	}

	.job-banner :global(.job) {
		flex: 1;
		max-width: 720px;
		margin-inline: auto;
		padding-block: 6px;
	}

	.tabbar {
		display: none;
	}

	@keyframes grow {
		from {
			transform: scaleX(0.4);
			opacity: 0;
		}
	}

	@media (max-width: 760px) {
		.bar {
			gap: 12px;
			padding-inline: 12px;
		}

		.word,
		.tabs {
			display: none;
		}

		.tabbar {
			position: sticky;
			bottom: 0;
			z-index: 4;
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			height: calc(var(--tab-h) + env(safe-area-inset-bottom));
			padding-bottom: env(safe-area-inset-bottom);
			background: var(--panel);
			box-shadow: 0 -1px 0 var(--rule);
		}

		.tabbar a {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 2px;
			color: var(--ink-3);
			font-size: 11px;
			font-weight: 500;
			text-decoration: none;
			transition: color var(--fast);
		}

		.tabbar a :global(svg) {
			width: 22px;
			height: 22px;
			stroke-width: 1.75;
			transition: transform var(--base) var(--ease);
		}

		.tabbar a[aria-current="page"] {
			color: var(--ink);
		}

		.tabbar a[aria-current="page"] :global(svg) {
			transform: translateY(-1px);
		}
	}
</style>
