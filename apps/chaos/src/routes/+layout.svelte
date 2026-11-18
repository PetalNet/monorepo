<script lang="ts">
	import { resolve } from "$app/paths";
	import ThemeToggle from "$lib/components/ThemeToggle.svelte";
	import type { Snippet } from "svelte";

	import "../app.css";

	import type { LayoutData } from "./$types";

	let { children, data }: { children: Snippet; data: LayoutData } = $props();
</script>

<div class="shell">
	<header>
		<a class="mark" href={resolve("/")}>Chaos tracker</a>
		<ThemeToggle initial={data.mode} />
	</header>

	{@render children()}

	<footer>
		<h2>Ground rules</h2>
		<ul>
			<li>Only primary sources move a reading.</li>
			<li>News and social claims are shown as "Reported, unconfirmed".</li>
			<li>Code sets every label and number. No model does.</li>
		</ul>
	</footer>
</div>

<style>
	.shell {
		max-inline-size: 76rem;
		margin-inline: auto;
		padding: 0 1rem 3rem;
	}
	@media (min-width: 60rem) {
		.shell {
			padding-inline: 2rem;
		}
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-block: 1rem;
	}
	.mark {
		font-size: 1.125rem;
		font-weight: 500;
		text-decoration: none;
	}
	footer {
		margin-block-start: 3rem;
		padding-block-start: 1.5rem;
		border-block-start: 1px solid var(--color-rule);
		font-size: 0.875rem;
		color: var(--color-muted);
	}
	footer h2 {
		margin: 0 0 0.5rem;
		font-size: inherit;
		font-weight: 500;
		color: var(--color-base-content);
	}
	footer ul {
		display: grid;
		gap: 0.25rem 2rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	@media (min-width: 60rem) {
		footer ul {
			grid-template-columns: repeat(3, max-content);
		}
	}
</style>
