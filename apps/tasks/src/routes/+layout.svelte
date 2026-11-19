<script>
	import "../app.css";
	import { afterNavigate, beforeNavigate, invalidate } from "$app/navigation";
	import { page } from "$app/state";

	import { openedProject } from "#lib/gallery.remote.ts";
	import Icon from "#lib/Icon.svelte";
	import NavSidebar from "#lib/NavSidebar.svelte";
	import { displayName, setPeople } from "#lib/people.js";
	let { children, data } = $props();
	setPeople(data.config.people);

	// sidebar collapse — persisted (desktop rail); on a phone the same sidebar is a sheet (navOpen)
	let collapsed = $state(false);
	let navOpen = $state(false);
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
	beforeNavigate(() => {
		navOpen = false;
	});
	// "Projects you opened" counts arrivals: this runs after a real navigation and on the first
	// load, never for a link that was only preloaded. Once per project per visit is enough.
	const told = new Set();
	afterNavigate(async () => {
		const project = page.data.opened;

		if (!project || told.has(project)) {
			return;
		}

		told.add(project);

		try {
			await openedProject({ project });

			// a visit can add the project to a narrowed view, so the sidebar moves it up
			if (data.tree.some((p) => p.key === project && !p.mine && !p.choice)) {
				await invalidate("gallery:tree");
			}
		} catch {
			told.delete(project);
		}
	});
	// the sheet is a modal on a phone: focus moves into it when it opens and back to the button when it closes
	let sheetBtn = $state();
	let wasOpen = false;
	$effect(() => {
		if (navOpen) {
			document.querySelector("#nav a")?.focus();
		} else if (wasOpen) {
			sheetBtn?.focus();
		}

		wasOpen = navOpen;
	});

	// who's signed in (Authentik -> locals.user -> data.user)
	const me = $derived(String(data.user || "dev").toLowerCase());
	const whoName = $derived(displayName(me));

	const path = $derived(page.url.pathname);
	// the Janet Call home is a bare page for the Android WebView: no tasks chrome
	const bare = $derived(path === "/janet/home");
	// where this page sits above the root; each page supplies its own ancestors
	const crumbs = $derived(page.data.crumbs ?? []);

	function toggleTheme() {
		const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";

		document.documentElement.dataset.theme = next;

		try {
			localStorage.setItem("tasks-theme", next);
		} catch {}
	}
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && (navOpen = false)} />

{#if bare}
	{@render children()}
{:else}
	<div class="app">
		<!-- skip link — first tab stop on every route (task-360) -->
		<a class="skip" href="#main">Skip to content</a>

		<NavSidebar
			bind:collapsed
			tree={data.tree}
			focused={data.focused}
			open={navOpen}
			onnavigate={() => (navOpen = false)}
		/>
		{#if navOpen}
			<button
				class="scrim"
				aria-label="Close projects"
				tabindex="-1"
				onclick={() => (navOpen = false)}
			></button>
		{/if}

		<main class="main" id="main" tabindex="-1">
			<header class="topbar">
				<button
					class="tb-btn tb-rail"
					onclick={() => (collapsed = !collapsed)}
					aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
					title={collapsed ? "Expand" : "Collapse"}
				>
					<Icon name={collapsed ? "expand" : "collapse"} size={18} />
				</button>
				<button
					class="tb-btn tb-sheet"
					bind:this={sheetBtn}
					onclick={() => (navOpen = !navOpen)}
					aria-label="Open projects"
					aria-expanded={navOpen}
					aria-controls="nav"
				>
					<Icon name="menu" size={18} />
				</button>

				<nav class="crumbs" aria-label="Breadcrumb">
					{#each crumbs as c (c.href)}
						<a href={c.href}>{c.label}</a>
					{/each}
					{#if !crumbs.length}<span class="root">gallery</span>{/if}
				</nav>

				<button class="tb-btn" onclick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
					<Icon name="moon" size={18} />
				</button>
				<span class="who" title="@{me}">
					<span class="avatar who-av">{whoName.charAt(0)}</span>
					<span class="who-nm">{whoName}</span>
				</span>
			</header>
			<div class="main-scroll">{@render children()}</div>
		</main>
	</div>
{/if}

<style>
	.app {
		height: 100dvh;
		display: flex;
		overflow: hidden;
	}
	/* shell column: a FIXED top bar + a SEPARATE inner scroller, so the bar never moves on
     overscroll (only the page itself should overscroll). */
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

	/* one top bar for every width: 56px so it lines up with the sidebar's brand row. Solid, flat. */
	.topbar {
		flex-shrink: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		gap: 6px;
		height: 56px;
		padding: 0 16px;
		background: var(--surface-1);
		border-bottom: 1px solid var(--border-sub);
	}
	.tb-btn {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		flex: none;
		border-radius: var(--radius);
		color: var(--text-3);
		transition:
			background 0.14s,
			color 0.14s;
	}
	.tb-btn:hover {
		background: var(--surface-2);
		color: var(--text-1);
	}
	.tb-sheet {
		display: none;
	}
	.crumbs {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
	}
	.crumbs a {
		color: var(--text-3);
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.crumbs a:hover {
		color: var(--accent-b);
	}
	.crumbs a + a::before {
		content: "/";
		margin-inline: 4px;
		color: var(--text-4);
	}
	.root {
		display: none;
		font-weight: 750;
		font-size: 16px;
		color: var(--text-1);
	}
	.who {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-inline-start: 4px;
		color: var(--text-2);
		font-size: 13px;
		font-weight: 600;
	}
	.who-av {
		width: 26px;
		height: 26px;
		font-size: 12px;
		color: var(--accent-b);
		background: var(--accent-bg);
		border-color: var(--accent);
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 39;
		background: rgba(0, 0, 0, 0.45);
	}

	/* ── responsive: phone (mirrors the app's 760px container query) ── */
	@container app (max-width: 760px) {
		.topbar {
			padding: 0 12px;
		}
		.tb-rail,
		.who-nm {
			display: none;
		}
		.tb-sheet {
			display: grid;
		}
		.root {
			display: inline;
		}
	}

	/* focus-visible ring lives in app.css (one global rule, hugging each element's own radius) */
	/* the skip-link target: no ring on programmatic focus, only when keyboard-focused directly */
	.main:focus {
		outline: none;
	}
</style>
