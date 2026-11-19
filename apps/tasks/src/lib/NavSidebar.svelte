<script>
	import { page } from "$app/stores";
	import Icon from "$lib/Icon.svelte";

	let { collapsed = $bindable(false) } = $props();

	const onGallery = $derived($page.url.pathname.startsWith("/gallery"));
</script>

<aside class="nav" class:collapsed>
	<a class="brand" href="/" aria-label="gallery home">
		<span class="brand-mark"><Icon name="brand" size={18} strokeWidth={1.9} /></span>
		<span class="wordmark">gallery</span>
	</a>

	<nav class="groups" aria-label="Main navigation">
		<a
			class="item"
			class:on={onGallery}
			href="/gallery"
			aria-current={onGallery ? "page" : undefined}
		>
			<Icon name="gallery" size={18} />
			<span class="lbl">Gallery</span>
		</a>
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

	/* primary action — SOLID accent fill so it's clearly distinct from the active-tab tint */
	/* collapsed: the icon stays exactly where it was (same margin + padding); only the label
     collapses and the rail narrows — the button never recenters, so the icon never moves (an operator) */

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

	/* FOOT: live Fleet — full roster, the sidebar's bottom anchor (clickable → /fleet) */
	/* bolt stays put on collapse; label + count fade + clip with the rail (consistent) */
	/* roster clips/fades + collapses its height on collapse — same .2s as the rail (an operator) */
</style>
