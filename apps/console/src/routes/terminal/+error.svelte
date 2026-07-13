<script lang="ts">
	import { page } from "$app/state";
	import Icon from "$lib/components/Icon.svelte";
</script>

<svelte:head><title>Terminal access denied · Lab Console</title></svelte:head>

<section class="denied" aria-labelledby="terminal-denied-title">
	<span aria-hidden="true"><Icon name="square-terminal" size={64} /><Icon name="lock-keyhole" size={28} /></span>
	<h1 id="terminal-denied-title">Not with your key. Ask an admin.</h1>
	<p>{page.status === 403 ? "This attempt was logged." : "Terminal gate unavailable. No session details were disclosed."}</p>
</section>

<style>
	.denied{min-height:70vh;display:grid;place-content:center;text-align:center;gap:var(--s-2)}
	.denied>span{position:relative;color:var(--text-3)}
	.denied>span :global(svg:last-child){position:absolute;left:calc(50% - 14px);top:18px;color:var(--danger-text)}
	h1{font:400 1.25rem var(--sign)}
	p{font-size:.75rem;color:var(--text-3)}
</style>
