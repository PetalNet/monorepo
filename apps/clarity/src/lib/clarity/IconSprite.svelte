<!--
	Clarity icon sprite — the inline <symbol> defs from the vanilla index.html.
	Rendered once at the top of the page so every <svg><use href="#i-…"/> in the
	UI resolves at first paint (SSR), no JS needed. Identical glyphs to legacy.
-->
<svg width="0" height="0" class="icon-sprite" aria-hidden="true">
	<defs>
		<symbol id="i-mark" viewBox="0 0 32 32"
			><rect
				x="3.5"
				y="3.5"
				width="25"
				height="25"
				rx="6"
				stroke="currentColor"
				stroke-width="1.4"
				fill="none"
			/><rect x="10" y="10" width="12" height="12" rx="2.5" fill="currentColor" /></symbol
		>
		<symbol
			id="i-search"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></symbol
		>
		<symbol
			id="i-x"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></symbol
		>
		<symbol
			id="i-mic"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
			><rect x="9" y="3" width="6" height="11" rx="3" /><path
				d="M5 11a7 7 0 0 0 14 0M12 18v3"
			/></symbol
		>
		<symbol
			id="i-image"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
			><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9.5" r="1.6" /><path
				d="m5 18 5-5 4 4 2-2 3 3"
			/></symbol
		>
		<symbol
			id="i-shield"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /></symbol
		>
		<symbol
			id="i-sun"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			><circle cx="12" cy="12" r="4.5" /><path
				d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
			/></symbol
		>
		<symbol
			id="i-moon"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linejoin="round"><path d="M20 14a8 8 0 1 1-10-10 6.5 6.5 0 0 0 10 10z" /></symbol
		>
		<symbol
			id="i-history"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
			><path d="M3 12a9 9 0 1 0 3-6.7M3 4v3.5h3.5" /><path d="M12 8v4l3 2" /></symbol
		>
		<symbol
			id="i-menu"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></symbol
		>
		<symbol
			id="i-up"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2.1"
			stroke-linecap="round"
			stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></symbol
		>
		<!-- Claire (AI answer) icons — Lucide: sparkles, check, circle-alert, rotate-cw, hourglass -->
		<symbol
			id="i-spark"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
			><path
				d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
			/><path d="M20 3v4M22 5h-4M4 17v2M5 18H3" /></symbol
		>
		<symbol
			id="i-check"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></symbol
		>
		<symbol
			id="i-alert"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
			><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></symbol
		>
		<symbol
			id="i-retry"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
			><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></symbol
		>
		<symbol
			id="i-hourglass"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
			><path d="M5 22h14M5 2h14" /><path
				d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"
			/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" /></symbol
		>
	</defs>
</svg>

<style>
	.icon-sprite {
		position: absolute;
	}
</style>
