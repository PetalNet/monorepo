<script lang="ts">
	import { asset } from "$app/paths";

	// Single import of the vendored design-system entry: live Tailwind v4 +
	// daisyUI build, PetalNet tokens, and the paper/ink themes. See
	// #lib/design-system/README.md for what's vendored and from where.
	import "#lib/design-system/app.css";
	// Clarity's own visual identity (the look users picked) layered over the DS
	// substrate. Imported after the DS so Clarity's --bg/--text/--accent win.
	import "#lib/clarity/clarity.css";

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={asset("icon.svg")} />
	<link
		rel="search"
		type="application/opensearchdescription+xml"
		title="Clarity"
		href={asset("opensearch.xml")}
	/>
</svelte:head>

{@render children()}
