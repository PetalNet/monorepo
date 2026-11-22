<script lang="ts">
	import { page } from "$app/state";
	import { globalFontFaces, preloads } from "fontless/runtime";

	import "../theme.css";
	let { data, children }: import("./$types").LayoutProps = $props();
	let staff = $derived(page.url.pathname.startsWith("/admin"));
</script>

<svelte:head>
	{#each preloads as attrs (attrs.href)}<link {...attrs} />{/each}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- Fontless emits trusted build-time CSS. -->
	{@html `<style>${globalFontFaces}</style>`}
</svelte:head>
<a class="skip" href="#content">Skip to content</a>
<div class:staff class="site">
	<header>
		<a class="brand" href="/" aria-label="Petal Relics home">petal relics</a>{#if staff}<span
				class="small">Tag workshop</span
			>{/if}
	</header>
	<main id="content">{@render children()}</main>
	<footer>
		<p>Small friend. Lovely story.</p>
		{#if page.url.pathname === "/"}<div class="footer-links">
				<a href={data.admin ? "/admin" : "/admin/login"}>Workshop</a><a
					href="https://github.com/PetalNet/monorepo"
					target="_blank"
					rel="noreferrer">Source</a
				>
			</div>{/if}
	</footer>
</div>

<style>
	.site {
		min-height: 100svh;
		max-width: 480px;
		margin-inline: auto;
		display: flex;
		flex-direction: column;
	}
	.site.staff {
		max-width: 1104px;
	}
	header {
		padding: 20px 24px 16px;
		min-height: 82px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}
	.brand {
		font: 500 19px/1 var(--font-display);
		text-decoration: none;
		min-height: 44px;
		display: flex;
		align-items: center;
	}
	main {
		width: 100%;
		flex: 1;
		padding: 12px 24px 32px;
		min-height: auto;
	}
	footer {
		padding: 24px;
		text-align: center;
		color: var(--muted);
	}
	footer > p {
		font: 20px/1.4 var(--font-note);
	}
	.footer-links {
		display: flex;
		justify-content: center;
		gap: 24px;
		font-size: 0.875rem;
		margin-block-start: 8px;
	}
	.footer-links a {
		min-height: 44px;
		display: flex;
		align-items: center;
	}
	.skip {
		position: fixed;
		inset-block-start: -100px;
		inset-inline-start: 16px;
		z-index: 100;
		background: var(--color-primary);
		color: var(--color-primary-content);
		padding: 16px;
	}
	.skip:focus {
		inset-block-start: 16px;
	}
	@media (min-width: 800px) {
		.staff header {
			padding-inline: 32px;
		}
		.staff main {
			padding: 24px 32px 48px;
		}
	}
</style>
