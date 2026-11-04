<script>
	import "../app.css";
	import { page } from "$app/stores";
	import Icon from "$lib/Icon.svelte";
	import NavSidebar from "$lib/NavSidebar.svelte";
	import { displayName, setPeople } from "$lib/people.js";
	import SearchBox from "$lib/SearchBox.svelte";
	let { children, data } = $props();
	setPeople(data.config.people);

	// sidebar collapse — persisted
	let collapsed = $state(false);
	$effect(() => {
		try {
			collapsed = localStorage.getItem("tasks-nav-collapsed") === "1";
		} catch {}
	});
	$effect(() => {
		try {
			localStorage.setItem("tasks-nav-collapsed", collapsed ? "1" : "0");
		} catch {}
	});

	// who's signed in (Authentik -> locals.user -> data.user)
	const me = $derived(String(data.user || "dev").toLowerCase());
	const whoName = $derived(displayName(me));

	const path = $derived($page.url.pathname);
	const isActive = (n) => {
		const p = path;

		if (n === "desk") {
			return p === "/";
		}

		if (n === "browse") {
			return p === "/browse" || p.startsWith("/task") || p.startsWith("/board");
		}

		if (n === "fleet") {
			return p.startsWith("/fleet");
		}

		if (n === "new") {
			return p.startsWith("/new");
		}

		return false;
	};

	// top-bar account menu + global search (the bar is now useful, not a section-name parrot)
	let acctOpen = $state(false);
	const q = $derived($page.url.searchParams.get("q") ?? "");

	function toggleTheme() {
		const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";

		document.documentElement.dataset.theme = next;

		try {
			localStorage.setItem("tasks-theme", next);
		} catch {}
	}
</script>

<div class="app">
	<!-- DESKTOP SIDEBAR — Nexus-style grouped nav, collapses to an icon rail -->
	<NavSidebar bind:collapsed fleet={data.fleet} />

	<!-- MOBILE topbar -->
	<header class="topbar">
		<a class="brand" href="/"
			><span class="brand-mark"><Icon name="brand" size={18} strokeWidth={2} /></span><span
				class="brand-name">tasks</span
			></a
		>
		<button class="ico-theme" onclick={toggleTheme} title="Theme" aria-label="Theme"
			><Icon name="moon" size={18} /></button
		>
	</header>

	<main class="main">
		<!-- DESKTOP top bar — toggle · global search · account menu (no section-name parrot) -->
		<header class="topbar-d">
			<button
				class="tb-toggle"
				onclick={() => (collapsed = !collapsed)}
				aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
				title={collapsed ? "Expand" : "Collapse"}
			>
				<Icon name={collapsed ? "expand" : "collapse"} size={18} />
			</button>

			<SearchBox value={q} />

			<div class="tb-acct">
				<button
					class="acct-btn"
					class:open={acctOpen}
					onclick={() => (acctOpen = !acctOpen)}
					aria-haspopup="menu"
					aria-expanded={acctOpen}
					aria-label="Account menu"
				>
					<span class="avatar acct-av">{whoName.charAt(0)}</span>
					<span class="acct-nm">{whoName}</span>
					<Icon name="chevdown" size={15} />
				</button>
				{#if acctOpen}
					<button
						class="acct-bd"
						aria-label="Close menu"
						tabindex="-1"
						onclick={() => (acctOpen = false)}
					></button>
					<div class="acct-menu" role="menu">
						<div class="acct-id">
							<span class="avatar acct-av lg">{whoName.charAt(0)}</span>
							<span class="acct-who"
								><span class="nm">{whoName}</span><span class="sub mono">@{me}</span></span
							>
						</div>
						<button class="acct-item" role="menuitem" onclick={toggleTheme}>
							<Icon name="moon" size={16} /> Toggle theme
						</button>
					</div>
				{/if}
			</div>
		</header>
		<div class="main-scroll">{@render children()}</div>
	</main>

	<!-- MOBILE bottom tab bar + More sheet -->
	<input type="checkbox" id="more-tgl" hidden />
	<label class="sheet-bd" for="more-tgl" aria-hidden="true"></label>
	<div class="sheet" role="dialog" aria-label="More">
		<h3>More</h3>
		<a href="/docs"><Icon name="doc" size={20} />Docs</a>
		<a href="/gallery"><Icon name="gallery" size={20} />Gallery</a>
		<a href="/projects"><Icon name="projects" size={20} />Projects</a>
	</div>
	<nav class="tabbar">
		<a class="tab" class:on={isActive("desk")} href="/"
			><Icon name="desk" size={20} /><span>Desk</span></a
		>
		<a class="tab" class:on={isActive("browse")} href="/browse"
			><Icon name="board" size={20} /><span>Browse</span></a
		>
		<a class="tab" class:on={isActive("fleet")} href="/fleet"
			><Icon name="bolt" size={20} /><span>Fleet</span></a
		>
		<a class="tab" class:on={isActive("new")} href="/new"
			><Icon name="plus" size={20} /><span>New</span></a
		>
		<label class="tab" for="more-tgl"><Icon name="more" size={20} /><span>More</span></label>
	</nav>
</div>

<style>
	/* ── shell layout ─────────────────────────────────────── */
	.app {
		height: 100dvh;
		display: flex;
		overflow: hidden;
	}
	/* shell column: a FIXED top bar + a SEPARATE inner scroller, so the bar never moves on
     overscroll (an operator: "only the page itself should overscroll" — sticky-inside-the-scroller
     still rubber-banded with the bounce; taking the bar out of the scroller is the real fix). */
	.main {
		flex: 1;
		min-width: 0;
		min-height: 0;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.main-scroll {
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
	}

	/* desktop top bar — holds the sidebar toggle + global search + account.
     height + vertical center match the sidebar brand/logomark row (no curve — squared chrome) */
	/* solid chrome — the bar sits above the scroller (content never passes under it),
     so a translucent blur is pure decoration (glass tell — an operator's /impeccable) */
	.topbar-d {
		flex-shrink: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		gap: 6px;
		height: 56px;
		padding: 0 16px;
		border-radius: 0;
		background: var(--surface-1);
		border-bottom: 1px solid var(--border-sub);
	}
	.tb-toggle {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border-radius: var(--radius);
		color: var(--text-3);
		transition:
			background 0.14s,
			color 0.14s;
	}
	.tb-toggle:hover {
		background: var(--surface-2);
		color: var(--text-1);
	}

	/* global search is the <SearchBox> component (task-506) — its own scoped styles */

	/* account — moved up from the sidebar foot (an operator) */
	.tb-acct {
		margin-left: auto;
		position: relative;
		flex-shrink: 0;
	}
	.acct-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 7px 4px 4px;
		border-radius: var(--radius);
		color: var(--text-1);
		transition: background 0.14s;
	}
	.acct-btn:hover,
	.acct-btn.open {
		background: var(--surface-2);
	}
	.acct-av {
		width: 26px;
		height: 26px;
		font-size: 12px;
		color: var(--accent-b);
		background: var(--accent-bg);
		border-color: var(--accent);
	}
	.acct-nm {
		font-size: 13px;
		font-weight: 600;
	}
	.acct-btn :global(svg) {
		color: var(--text-4);
	}
	.acct-bd {
		position: fixed;
		inset: 0;
		z-index: 30;
		background: transparent;
	}
	.acct-menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 31;
		min-width: 208px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: 0 10px 30px -8px rgba(0, 0, 0, 0.28);
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.acct-id {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 8px 11px;
		border-bottom: 1px solid var(--border-sub);
		margin-bottom: 5px;
	}
	.acct-av.lg {
		width: 34px;
		height: 34px;
		font-size: 14px;
	}
	.acct-who {
		display: flex;
		flex-direction: column;
		line-height: 1.25;
		min-width: 0;
	}
	.acct-who .nm {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--text-1);
	}
	.acct-who .sub {
		font-size: 11px;
		color: var(--text-4);
	}
	.acct-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 8px 9px;
		border-radius: var(--radius);
		font-size: 13px;
		color: var(--text-2);
		text-decoration: none;
	}
	.acct-item:hover {
		background: var(--surface-2);
		color: var(--text-1);
	}
	.acct-item :global(svg) {
		color: var(--text-4);
		flex-shrink: 0;
	}

	/* mobile chrome hidden on desktop */
	.topbar,
	.tabbar,
	.sheet,
	.sheet-bd {
		display: none;
	}

	/* ── responsive: phone (mirrors the app's 760px container query) ── */
	@container app (max-width: 760px) {
		.app {
			display: flex;
			flex-direction: column;
		}
		.app :global(.nav) {
			display: none;
		}
		.topbar-d {
			display: none;
		}
		.topbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 9px 15px;
			background: var(--surface-1);
			border-bottom: 1px solid var(--border-sub);
			position: sticky;
			top: 0;
			z-index: 5;
		}
		.topbar .brand {
			display: flex;
			align-items: center;
			gap: 9px;
			text-decoration: none;
		}
		.topbar .brand-mark {
			display: grid;
			place-items: center;
			color: var(--accent-b);
		}
		.topbar .brand-name {
			font-weight: 750;
			font-size: 16px;
			letter-spacing: -0.01em;
			color: var(--text-1);
		}
		.topbar .ico-theme {
			width: 32px;
			height: 32px;
			display: grid;
			place-items: center;
			border-radius: var(--radius);
			color: var(--text-3);
		}
		.topbar .ico-theme:hover {
			background: var(--surface-2);
			color: var(--text-1);
		}
		.main {
			height: auto;
			flex: 1;
		}

		.tabbar {
			display: flex;
			background: var(--surface-1);
			border-top: 1px solid var(--border-sub);
			flex-shrink: 0;
			padding: 6px 6px calc(6px + env(safe-area-inset-bottom));
			position: sticky;
			bottom: 0;
			z-index: 5;
		}
		.tab {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 3px;
			padding: 7px 4px;
			border-radius: var(--radius);
			color: var(--text-4);
			font-size: 9.5px;
			font-weight: 600;
			text-decoration: none;
			cursor: pointer;
		}
		.tab.on {
			color: var(--accent-b);
		}

		/* "More" sheet — the tucked-away secondary nav */
		#more-tgl:checked ~ .sheet-bd {
			display: block;
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.5);
			z-index: 40;
		}
		#more-tgl:checked ~ .sheet {
			display: flex;
		}
		.sheet {
			position: fixed;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 41;
			flex-direction: column;
			gap: 2px;
			background: var(--surface-1);
			border-top: 1px solid var(--border);
			border-radius: var(--radius-lg) var(--radius-lg) 0 0;
			padding: 10px 12px calc(16px + env(safe-area-inset-bottom));
		}
		.sheet h3 {
			font-size: 10px;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--text-4);
			font-family: var(--mono);
			padding: 8px 8px 6px;
		}
		.sheet a {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 13px 12px;
			border-radius: var(--radius);
			color: var(--text-2);
			font-size: 14.5px;
			font-weight: 500;
			text-decoration: none;
		}
		.sheet a:hover {
			background: var(--surface-2);
		}
	}

	:where(a, button, input, select, label, [tabindex]):focus-visible {
		outline: 2px solid var(--accent-b);
		outline-offset: 2px;
		border-radius: 3px;
	}
</style>
