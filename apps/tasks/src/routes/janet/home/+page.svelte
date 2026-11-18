<script>
	import { onMount } from "svelte";

	let { data } = $props();
	let html = $state(data.html);
	let updatedAt = $state(data.updated_at);
	let now = $state(Date.now());
	let live = $state(false);

	function ago(iso, t) {
		if (!iso) {
			return "not written yet";
		}

		const m = Math.floor((t - new Date(iso).getTime()) / 60_000);

		if (m < 1) {
			return "updated just now";
		}

		if (m < 60) {
			return `updated ${m} min ago`;
		}

		const h = Math.floor(m / 60);

		return h < 48 ? `updated ${h} h ago` : `updated ${Math.floor(h / 24)} d ago`;
	}

	// Live swap over SSE. The browser's own EventSource retry gives up for good when the
	// auth proxy answers with a redirect, so reconnect by hand with capped backoff.
	onMount(() => {
		let es;
		let timer;
		let delay = 1000;
		let stopped = false;

		const connect = () => {
			es = new EventSource("/janet/home/events");

			es.onopen = () => {
				live = true;
				delay = 1000;
			};

			es.addEventListener("home", (e) => {
				const d = JSON.parse(e.data);

				html = d.html;
				updatedAt = d.updated_at;
			});

			es.onerror = () => {
				live = false;
				es.close();

				if (!stopped) {
					timer = setTimeout(connect, delay);
					delay = Math.min(delay * 2, 30_000);
				}
			};
		};

		connect();

		const tick = setInterval(() => (now = Date.now()), 30_000);

		return () => {
			stopped = true;
			clearTimeout(timer);
			clearInterval(tick);
			es?.close();
		};
	});
</script>

<svelte:head>
	<title>Janet</title>
	<meta name="color-scheme" content="light dark" />
</svelte:head>

<div class="home">
	<main>
		<header>
			<h1>Janet</h1>
			<p class="stamp"><i class:live></i>{ago(updatedAt, now)}</p>
		</header>
		<article class="doc">
			{#if html}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by renderMd -->
				{@html html}
			{:else}
				<p class="empty">Nothing here yet.</p>
			{/if}
		</article>
	</main>
	<footer>
		<a class="call" href="janetcall://call">
			<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
				><path
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"
				/></svg
			>
			Call Janet
		</a>
	</footer>
</div>

<style>
	.home {
		--paper: #fff;
		--ground: #f7f7f5;
		--ink: #0a0a0a;
		--g1: #4a4a4a;
		--g2: #666663;
		--hair: #e4e4e2;
		--tint: #ececea;
		--petal: #b5502f;
		--ok: #2f7d4f;
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--ground);
		color: var(--ink);
		font-size: 15px;
		line-height: 1.5;
		font-family: var(--sans);
	}
	@media (prefers-color-scheme: dark) {
		.home {
			--paper: #1a1a1a;
			--ground: #0b0b0b;
			--ink: #f3f3ef;
			--g1: #c6c6c2;
			--g2: #a2a29e;
			--hair: #2a2a2a;
			--tint: #202020;
			--petal: #e2725b;
			--ok: #5fbf86;
		}
	}
	main {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		padding: 20px 16px 16px;
		padding-top: max(20px, env(safe-area-inset-top));
		max-width: 640px;
		width: 100%;
		margin: 0 auto;
		box-sizing: border-box;
	}
	header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 14px;
	}
	h1 {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.stamp {
		margin: 0;
		font-size: 12.5px;
		color: var(--g2);
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.stamp i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--hair);
	}
	.stamp i.live {
		background: var(--ok);
	}
	.doc {
		background: var(--paper);
		border: 1px solid var(--hair);
		border-radius: 16px;
		padding: 4px 16px 12px;
		overflow-wrap: anywhere;
	}
	.doc :global(h1),
	.doc :global(h2),
	.doc :global(h3) {
		margin: 18px 0 6px;
		font-size: 12px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--g2);
	}
	.doc :global(h1) {
		font-size: 18px;
		text-transform: none;
		letter-spacing: -0.01em;
		font-weight: 600;
		color: var(--ink);
	}
	.doc :global(p),
	.doc :global(ul),
	.doc :global(ol),
	.doc :global(table),
	.doc :global(blockquote),
	.doc :global(pre) {
		margin: 6px 0;
	}
	.doc :global(ul),
	.doc :global(ol) {
		padding-left: 20px;
	}
	.doc :global(a) {
		color: var(--petal);
	}
	.doc :global(hr) {
		border: 0;
		border-top: 1px solid var(--hair);
		margin: 14px 0;
	}
	.doc :global(table) {
		border-collapse: collapse;
		width: 100%;
		font-size: 14px;
	}
	.doc :global(th),
	.doc :global(td) {
		text-align: left;
		padding: 6px 8px 6px 0;
		border-bottom: 1px solid var(--hair);
	}
	.doc :global(th) {
		color: var(--g2);
		font-weight: 500;
		white-space: nowrap;
	}
	.doc :global(code) {
		font-family: var(--mono);
		font-size: 0.9em;
		background: var(--tint);
		padding: 1px 5px;
		border-radius: 6px;
	}
	.doc :global(pre) {
		background: var(--tint);
		padding: 10px 12px;
		border-radius: 10px;
		overflow-x: auto;
	}
	.doc :global(pre code) {
		background: none;
		padding: 0;
	}
	.doc :global(blockquote) {
		background: var(--tint);
		border-radius: 10px;
		padding: 6px 12px;
		color: var(--g1);
	}
	.empty {
		color: var(--g2);
	}
	footer {
		padding: 10px 16px;
		padding-bottom: max(14px, env(safe-area-inset-bottom));
		max-width: 640px;
		width: 100%;
		margin: 0 auto;
		box-sizing: border-box;
	}
	.call {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		min-height: 52px;
		border-radius: 999px;
		background: var(--ink);
		color: var(--paper);
		font-weight: 600;
		font-size: 16px;
		text-decoration: none;
	}
	.call:focus-visible {
		outline: 2px solid var(--petal);
		outline-offset: 3px;
	}
</style>
