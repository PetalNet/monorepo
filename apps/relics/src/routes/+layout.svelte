<script lang="ts">
	import { page } from "$app/state";
	import { Sun, Moon, Library, ShieldCheck } from "@lucide/svelte";
	import { globalFontFaces, preloads } from "fontless/runtime";
	import { onMount } from "svelte";

	import Mushroom from "#lib/components/Mushroom.svelte";

	import "../theme.css";
	let { data, children }: import("./$types").LayoutProps = $props();
	let light = $state(false);
	onMount(() => {
		light = document.documentElement.dataset.theme === "relics-light";
	});
	function toggle() {
		light = !light;
		document.documentElement.dataset.theme = light ? "relics-light" : "relics-dark";

		try {
			localStorage.setItem("relics-theme", light ? "light" : "dark");
		} catch {
			light = document.documentElement.dataset.theme === "relics-light";
		}
	}
</script>

<svelte:head>
	{#each preloads as attrs (attrs.href)}
		<link {...attrs} />
	{/each}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- Fontless emits trusted build-time CSS. -->
	{@html `<style>${globalFontFaces}</style>`}
</svelte:head>

<a class="skip" href="#content">Skip to content</a>
<header>
	<a class="brand" href="/" aria-label="Petal Relics home"
		><Mushroom size={28} /><span>Petal <strong>Relics</strong></span></a
	>
	<nav aria-label="Main navigation">
		<a class:active={page.url.pathname === "/collection"} href="/collection"
			><Library size={18} /><span>My collection</span>{#if data.collection.relics.length}<span
					class="count">{data.collection.relics.length}</span
				>{/if}</a
		><button
			class="btn btn-ghost btn-square"
			onclick={toggle}
			aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
			>{#if light}<Moon size={20} />{:else}<Sun size={20} />{/if}</button
		>
	</nav>
</header>
<main id="content">{@render children()}</main>
<footer>
	<span>Physical relics. Personal collections.</span>
	<a
		href="https://github.com/PetalNet/monorepo"
		target="_blank"
		rel="noreferrer"
		aria-label="Source code">Source</a
	>
	<a href={data.admin ? "/admin" : "/admin/login"}
		><ShieldCheck size={14} />{data.admin ? "Admin tools" : "Admin"}</a
	>
</footer>

<style>
	header {
		max-width: 1440px;
		margin-inline: auto;
		padding: 24px 48px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		border-block-end: 1px solid var(--rule);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 12px;
		text-decoration: none;
		font-size: 1.25rem;
		white-space: nowrap;
	}
	.brand strong {
		font-weight: 500;
	}
	.brand {
		color: var(--color-primary);
	}
	nav {
		display: flex;
		align-items: center;
		gap: 24px;
	}
	nav > a {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 48px;
		text-decoration: none;
		font-size: 0.875rem;
		color: var(--muted);
	}
	nav > a:hover,
	nav > a.active {
		color: var(--color-base-content);
	}
	.count {
		font-variant-numeric: tabular-nums;
		color: var(--color-primary);
	}
	footer {
		max-width: 1440px;
		margin-inline: auto;
		padding: 24px 48px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		border-block-start: 1px solid var(--rule);
		font-size: 0.75rem;
		color: var(--muted);
	}
	footer a {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		text-decoration: none;
	}
	.skip {
		position: fixed;
		top: -100px;
		inset-inline-start: 16px;
		z-index: 100;
		padding: 16px;
		background: var(--color-primary);
		color: var(--color-primary-content);
	}
	.skip:focus {
		top: 16px;
	}
	@media (max-width: 600px) {
		header {
			padding: 16px 20px;
		}
		.brand {
			font-size: 1rem;
			gap: 8px;
		}
		nav {
			gap: 8px;
		}
		nav > a {
			font-size: 0.75rem;
		}
		nav > a :global(svg) {
			display: none;
		}
		footer {
			padding: 16px 20px;
			gap: 16px;
		}
		footer > span {
			max-width: 22ch;
		}
	}
</style>
