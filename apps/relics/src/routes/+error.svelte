<script lang="ts">
	import { page } from "$app/state";
</script>

<svelte:head><title>{page.status} · Petal Relics</title></svelte:head>
<div class="form-panel">
	<p class="muted small">{page.status}</p>
	<h1>
		{page.status === 401
			? "Admin sign-in required."
			: page.status === 404
				? "We can’t find this specimen."
				: "Something needs another look."}
	</h1>
	<p>{page.error?.message ?? "Please try again in a moment."}</p>
	<div class="actions" style="margin-block-start:24px">
		{#if page.status === 401}<a class="btn btn-primary" href="/admin/login">Admin sign-in</a>{/if}<a
			class="btn btn-ghost"
			href="/collection">My collection</a
		><a class="btn btn-ghost" href="/">Home</a>
	</div>
</div>
