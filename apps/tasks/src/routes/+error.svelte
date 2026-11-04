<script>
	import { page } from "$app/stores";
	const status = $derived($page.status);
	const message = $derived($page.error?.message || "Something went sideways.");
	const is404 = $derived(status === 404);
</script>

<svelte:head><title>{status} · tasks</title></svelte:head>

<!-- self-contained sprite: the error page must render even if the layout load threw (no shell sprite) -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true"
	><defs>
		<symbol
			id="e-inbox"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			><path d="M4 13h4l1.5 3h5L16 13h4" /><path d="M4 13 6 5h12l2 8v6H4z" /></symbol
		>
		<symbol
			id="e-block"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></symbol
		>
		<symbol
			id="e-arrow"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></symbol
		>
	</defs></svg
>

<div class="screen err">
	<div class="err-card">
		<span class="err-ic" class:warn={!is404}>
			<svg width="26" height="26" aria-hidden="true"
				><use href="#e-{is404 ? 'inbox' : 'block'}" /></svg
			>
		</span>
		<div class="err-code mono">{status}</div>
		<h1>{is404 ? "Nothing here" : "That broke"}</h1>
		<p class="err-msg">{message}</p>
		<a class="err-back" href="/">
			<svg width="14" height="14" style="transform:scaleX(-1)" aria-hidden="true"
				><use href="#e-arrow" /></svg
			>
			back to the board
		</a>
	</div>
</div>

<style>
	.err {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 70vh;
	}
	.err-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 8px;
		max-width: 380px;
		padding: 34px 30px;
		background: var(--surface-1);
		border: 1px solid var(--border-sub);
		border-radius: var(--radius-lg);
	}
	.err-ic {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--accent-bg);
		color: var(--accent-b);
		margin-bottom: 4px;
	}
	.err-ic.warn {
		background: rgba(220, 38, 38, 0.12);
		color: var(--danger-b);
	}
	.err-code {
		font-size: 12px;
		letter-spacing: 0.14em;
		color: var(--text-4);
	}
	.err-card h1 {
		font-size: 21px;
		font-weight: 650;
		letter-spacing: -0.02em;
		color: var(--text-1);
		margin: 0;
	}
	.err-msg {
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text-3);
		margin: 2px 0 14px;
	}
	.err-back {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		text-decoration: none;
		font-family: var(--mono);
		font-size: 12px;
		color: var(--text-2);
		background: var(--surface-2);
		border: 1px solid var(--border-sub);
		border-radius: var(--radius);
		padding: 9px 15px;
		transition: 0.12s;
	}
	.err-back:hover {
		color: var(--accent-b);
		border-color: var(--accent-ln);
		background: var(--accent-bg);
	}
</style>
