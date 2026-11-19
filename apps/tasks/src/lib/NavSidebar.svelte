<script>
	import { page } from "$app/state";

	import { galleryHref, UNFILED } from "#lib/gallery-tree.js";
	import Icon from "#lib/Icon.svelte";

	/** @type {{ collapsed?: boolean; tree?: any[]; open?: boolean; onnavigate?: () => void }} */
	let { collapsed = $bindable(false), tree = [], open = false, onnavigate } = $props();

	// Which project and piece of work the page is in: from the query on the index, from the
	// artifact's breadcrumb trail on an artifact page.
	const scope = $derived.by(() => {
		const q =
			page.url.pathname === "/gallery"
				? page.url.searchParams
				: new URLSearchParams((page.data.crumbs?.at(-1)?.href ?? "").split("?")[1] ?? "");

		return { project: q.get("project") ?? "", work: q.get("work") ?? "" };
	});
	const onGallery = $derived(page.url.pathname.startsWith("/gallery"));
	const everything = $derived(page.url.pathname === "/gallery" && !scope.project && !scope.work);
</script>

<aside class="nav" class:collapsed class:open id="nav">
	<a class="brand" href="/" aria-label="gallery home" onclick={onnavigate}>
		<span class="brand-mark"><Icon name="brand" size={18} strokeWidth={1.9} /></span>
		<span class="wordmark">gallery</span>
	</a>

	<nav class="groups" aria-label="Projects">
		<a
			class="item"
			class:on={everything}
			href="/gallery"
			aria-current={everything ? "page" : undefined}
			onclick={onnavigate}
		>
			<Icon name="gallery" size={18} />
			<span class="lbl">All projects</span>
		</a>

		{#each tree as p (p.key)}
			{@const here = onGallery && scope.project === p.key}
			{@const whole = here && !scope.work}
			<a
				class="item"
				class:on={whole}
				class:here={here && !whole}
				href={galleryHref({ project: p.key })}
				aria-current={whole ? "page" : undefined}
				title={p.name}
				onclick={onnavigate}
			>
				<Icon name="projects" size={18} />
				<span class="lbl">{p.key === UNFILED ? "unfiled" : p.name}</span>
				{#if p.needs}<span class="needs" title="{p.needs} waiting on you">{p.needs}</span>{/if}
				<span class="n">{p.count}</span>
			</a>
			{#if here && p.works.length && !collapsed}
				<div class="works">
					{#each p.works as w (w.key)}
						{@const on = scope.work === w.key}
						<a
							class="sub"
							class:on
							href={galleryHref({ project: p.key, work: w.key })}
							aria-current={on ? "page" : undefined}
							onclick={onnavigate}
						>
							<span class="lbl mono">{w.label}</span>
							<span class="n">{w.count}</span>
						</a>
					{/each}
				</div>
			{/if}
		{/each}
	</nav>
</aside>

<style>
	.nav {
		--w: 232px;
		width: var(--w);
		flex-shrink: 0;
		height: 100dvh;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 0 12px 12px;
		background: var(--surface-1);
		border-right: 1px solid var(--border-sub);
		border-radius: 0;
		/* GCal-style smooth collapse: animate the rail WIDTH with overflow:hidden so the labels are
       CLIPPED (not squished/reflowed) as it narrows — that's the whole trick to it looking smooth
       (an operator's reference). Icons stay pinned; labels just fade + clip, nothing inside relayouts. */
		transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
		overflow: hidden;
		position: relative;
		z-index: 6;
		/* contain layout so the collapse reflow physically can't escape the rail (an operator) */
		contain: layout;
	}
	/* collapsed keeps the SAME left/right padding as expanded so every icon's x is identical
     in both states — only the rail width + labels animate, icons never slide (an operator). */
	.nav.collapsed {
		--w: 68px;
	}
	@media (prefers-reduced-motion: reduce) {
		.nav {
			transition: none;
		}
	}

	/* brand row = a 56px header, content vertically centered, so the logomark lines up EXACTLY with
     the top bar's row across the sidebar/main seam (an operator: "not aligned at all" — was a too-big
     logomark + lopsided padding). */
	.brand {
		display: flex;
		align-items: center;
		gap: 9px;
		height: 56px;
		padding: 0 9px;
		text-decoration: none;
		min-width: 0;
	}
	.brand-mark {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		color: var(--accent-b);
	}
	.wordmark {
		font-weight: 750;
		font-size: 18px;
		letter-spacing: -0.01em;
		color: var(--text-1);
		white-space: nowrap;
		overflow: hidden;
		transition: opacity 0.11s ease;
		max-width: 120px;
	}
	/* collapsed: brand-mark stays put; the wordmark fades + clips (overflow), no box-collapse */
	.collapsed .wordmark {
		opacity: 0;
	}

	.groups {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow-y: auto;
		overflow-x: hidden;
		margin: 0 -2px;
		padding: 0 2px;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 11px;
		overflow: hidden;
		padding: 8px 11px;
		border-radius: var(--radius);
		text-decoration: none;
		white-space: nowrap;
		color: var(--text-3);
		font-size: 13.5px;
		font-weight: 500;
		transition:
			background 0.14s,
			color 0.14s;
	}
	.item :global(svg) {
		flex-shrink: 0;
	}
	.item:hover {
		background: var(--surface-2);
		color: var(--text-1);
	}
	/* single highlight: the pill fill + the icon picks up accent — no second tile background */
	.item.on {
		background: var(--accent-bg);
		color: var(--accent-b);
		font-weight: 600;
	}
	/* collapse: only the label opacity animates; max-width changes instantly (no layout animation). */
	.item .lbl {
		max-width: 140px;
		overflow: hidden;
		transition: opacity 0.11s ease;
	}
	/* icon pinned: keep base padding/gap; label fades + clips via overflow (no box-collapse) */
	.collapsed .item .lbl {
		opacity: 0;
	}

	/* counts sit at the end of the row and clip with the label when the rail collapses */
	.n {
		margin-inline-start: auto;
		font-size: 11.5px;
		font-variant-numeric: tabular-nums;
		color: var(--text-4);
		transition: opacity 0.11s ease;
	}
	.collapsed .n,
	.collapsed .needs {
		opacity: 0;
	}
	.needs {
		min-width: 18px;
		padding: 0 5px;
		border-radius: 9px;
		text-align: center;
		font-size: 11px;
		font-weight: 650;
		line-height: 18px;
		color: var(--bg);
		background: var(--accent-b);
		transition: opacity 0.11s ease;
	}
	/* inside the open project but on one of its pieces of work: keep the row quiet, not filled */
	.item.here {
		color: var(--text-1);
	}
	.works {
		display: flex;
		flex-direction: column;
		gap: 1px;
		margin: 0 0 4px 22px;
		padding-inline-start: 11px;
		border-inline-start: 1px solid var(--border);
	}
	.sub {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 9px;
		border-radius: var(--radius);
		text-decoration: none;
		font-size: 12px;
		color: var(--text-3);
		transition:
			background 0.14s,
			color 0.14s;
	}
	.sub .lbl {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub:hover {
		background: var(--surface-2);
		color: var(--text-1);
	}
	.sub.on {
		background: var(--accent-bg);
		color: var(--accent-b);
		font-weight: 600;
	}

	/* phone: the rail becomes a sheet that slides over the page, opened from the top bar */
	@container app (max-width: 760px) {
		.nav {
			position: fixed;
			inset-block: 0;
			inset-inline-start: 0;
			z-index: 40;
			--w: min(288px, 86vw);
			transform: translateX(-100%);
			visibility: hidden;
			transition:
				transform 0.2s cubic-bezier(0.4, 0, 0.2, 1),
				visibility 0s linear 0.2s;
		}
		.nav.open {
			transform: none;
			visibility: visible;
			transition-delay: 0s;
		}
		.nav.collapsed {
			--w: min(288px, 86vw);
		}
		.collapsed .wordmark,
		.collapsed .item .lbl,
		.collapsed .n,
		.collapsed .needs {
			opacity: 1;
		}
	}
</style>
