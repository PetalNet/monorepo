<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";

	import type { LayoutData } from "./$types";

	let { children, data }: { children: any; data: LayoutData } = $props();
	const user = $derived(data.user);
	let mobileNavOpen = $state(false);

	// Initialize darkMode from localStorage immediately to prevent flicker
	let darkMode = $state(
		typeof localStorage !== "undefined" && localStorage.getItem("darkMode") === "true",
	);

	// Track if we're on an event page
	let isEventPage = $state(false);
	let eventEmoji = $state("");
	let eventTitle = $state("");

	// Watch for event page changes
	$effect(() => {
		if (typeof document !== "undefined") {
			const checkEventPage = () => {
				isEventPage = document.documentElement.hasAttribute("data-event-page");
				eventEmoji = document.documentElement.getAttribute("data-event-emoji") || "";
				eventTitle = document.documentElement.getAttribute("data-event-title") || "";
			};

			checkEventPage();

			// Re-check periodically for route changes
			const observer = new MutationObserver(checkEventPage);

			observer.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ["data-event-page", "data-event-emoji", "data-event-title"],
			});

			return () => observer.disconnect();
		}
	});

	function closeMobileNav() {
		mobileNavOpen = false;
	}

	function toggleDarkMode() {
		darkMode = !darkMode;

		if (typeof localStorage !== "undefined") {
			localStorage.setItem("darkMode", darkMode ? "true" : "false");
		}

		applyDarkMode();
	}

	function applyDarkMode() {
		if (typeof document === "undefined") {
			return;
		}

		document.documentElement.classList.toggle("dark", darkMode);
	}

	onMount(() => {
		// Ensure dark mode class is applied on mount
		applyDarkMode();

		// Handle async font loading
		const fontLink = document.querySelector('link[media="print"][href*="fonts.googleapis.com"]');

		if (fontLink) {
			fontLink.addEventListener("load", () => {
				(fontLink as HTMLLinkElement).media = "all";
			});
		}
	});

	$effect(() => {
		if (typeof document === "undefined") {
			return;
		}

		document.body.classList.toggle("no-scroll", mobileNavOpen);
	});
</script>

<svelte:head>
	<title>PetalBoard</title>
	<meta
		name="description"
		content="Create polished event signups without forcing guests to make accounts."
	/>
	<!-- Critical resource hints -->
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<!-- Upgrade to preconnect for Google Maps to reduce connection latency -->
	<link rel="preconnect" href="https://maps.googleapis.com" />
	<link rel="preconnect" href="https://maps.gstatic.com" crossorigin="anonymous" />
	<link rel="dns-prefetch" href="https://i.scdn.co" />

	<!-- Load fonts with optimal display strategy -->
	<link
		rel="stylesheet"
		href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lexend:wght@600&display=swap"
		media="print"
	/>
	<noscript>
		<link
			href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lexend:wght@600&display=swap"
			rel="stylesheet"
		/>
	</noscript>
</svelte:head>

<div class="layout-shell box-border flex min-h-screen w-full max-w-full flex-col overflow-x-hidden">
	<header
		class="top-nav sticky top-0 z-30 flex items-center justify-between border-b px-4 py-3 backdrop-blur-[14px] transition-all lg:px-12"
		class:dark-header={darkMode}
		class:event-header={isEventPage}
	>
		<a
			class="brand-link flex items-center gap-2 font-brand text-2xl font-bold lg:text-[1.85rem]"
			href="/"
			onclick={closeMobileNav}
		>
			<span class="text-3xl lg:text-4xl">🌸</span>
			<span class="hidden lg:inline">PetalBoard</span>
		</a>

		<div class="flex items-center gap-3 md:hidden">
			{#if user}
				<a
					href="/create"
					class="btn-secondary rounded-2xl px-4 py-2 text-sm font-semibold"
					onclick={closeMobileNav}
				>
					New Event
				</a>
			{/if}
			<button
				class="mobile-nav-toggle"
				type="button"
				aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
				aria-expanded={mobileNavOpen}
				onclick={() => (mobileNavOpen = !mobileNavOpen)}
			>
				<span class:open={mobileNavOpen}></span>
				<span class:open={mobileNavOpen}></span>
				<span class:open={mobileNavOpen}></span>
			</button>
		</div>

		<nav class="hidden items-center gap-6 md:flex">
			{#if user}
				<a
					href="/dashboard"
					class="nav-link font-medium no-underline transition-opacity hover:opacity-80">Dashboard</a
				>
				<a
					href="/create"
					class="nav-link font-medium no-underline transition-opacity hover:opacity-80"
					>Create Event</a
				>
				<a
					href="/settings"
					class="nav-link font-medium no-underline transition-opacity hover:opacity-80">Settings</a
				>
				<button
					type="button"
					onclick={toggleDarkMode}
					class="nav-icon-button cursor-pointer border-none bg-transparent p-0 text-2xl font-medium no-underline transition-opacity hover:opacity-80"
					aria-label="Toggle dark mode"
					title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
				>
					{darkMode ? "☀️" : "🌙"}
				</button>
				<span class="nav-meta text-sm">{user.email}</span>
				<form method="POST" action="/logout" class="inline">
					<button
						type="submit"
						class="nav-link font-inherit cursor-pointer border-none bg-transparent p-0 font-medium transition-opacity hover:opacity-80"
						>Log out</button
					>
				</form>
			{:else}
				<button
					type="button"
					onclick={toggleDarkMode}
					class="nav-icon-button cursor-pointer border-none bg-transparent p-0 text-2xl font-medium no-underline transition-opacity hover:opacity-80"
					aria-label="Toggle dark mode"
					title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
				>
					{darkMode ? "☀️" : "🌙"}
				</button>
				<a
					href="/login"
					class="nav-link font-medium no-underline transition-opacity hover:opacity-80">Log in</a
				>
				<a
					href="/register"
					class="nav-link font-medium no-underline transition-opacity hover:opacity-80">Register</a
				>
			{/if}
		</nav>
	</header>

	{#if mobileNavOpen}
		<div
			class="mobile-nav-overlay"
			role="button"
			tabindex="0"
			aria-label="Close navigation menu"
			onclick={closeMobileNav}
			onkeydown={(event) => {
				if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					closeMobileNav();
				}
			}}
		></div>
	{/if}

	<aside class:hidden={!mobileNavOpen} class="mobile-nav-panel">
		<nav class="flex flex-col gap-3">
			{#if user}
				<a href="/dashboard" class="mobile-nav-link" onclick={closeMobileNav}>Dashboard</a>
				<a href="/create" class="mobile-nav-link" onclick={closeMobileNav}>Create Event</a>
				<a href="/settings" class="mobile-nav-link" onclick={closeMobileNav}>Settings</a>
				<button
					type="button"
					onclick={() => {
						toggleDarkMode();
						closeMobileNav();
					}}
					class="mobile-nav-link flex items-center gap-2 text-left"
				>
					<span class="text-xl">{darkMode ? "☀️" : "🌙"}</span>
					<span>{darkMode ? "Light Mode" : "Dark Mode"}</span>
				</button>
				<div class="mobile-nav-meta">
					<span>{user.email}</span>
					<form method="POST" action="/logout">
						<button type="submit" class="mobile-nav-link w-full text-left" onclick={closeMobileNav}
							>Log out</button
						>
					</form>
				</div>
			{:else}
				<button
					type="button"
					onclick={() => {
						toggleDarkMode();
						closeMobileNav();
					}}
					class="mobile-nav-link flex items-center gap-2 text-left"
				>
					<span class="text-xl">{darkMode ? "☀️" : "🌙"}</span>
					<span>{darkMode ? "Light Mode" : "Dark Mode"}</span>
				</button>
				<a href="/login" class="mobile-nav-link" onclick={closeMobileNav}>Log in</a>
				<a href="/register" class="mobile-nav-link" onclick={closeMobileNav}>Register</a>
			{/if}
		</nav>
	</aside>

	<main
		class="mx-auto box-border w-full max-w-full flex-1 overflow-x-hidden px-4 pb-20 pt-6 lg:px-12 lg:py-12"
	>
		{@render children()}
	</main>

	<footer class="px-4 py-8 text-center text-sm text-[rgba(46,24,83,0.7)]">
		<p>Made with ❤️ - Parker</p>
	</footer>
</div>

<style>
	.layout-shell {
		background: transparent;
	}

	:global(html[data-event-page]) .layout-shell {
		background-color: var(--event-page-background, #f7f5ff);
		background-image: var(--event-background-overlay, none), var(--event-background-image, none);
		background-repeat: no-repeat;
		background-size: cover;
		background-position: center;
		background-attachment: var(--event-background-attachment, scroll);
	}

	:global(html[data-event-page].dark) .layout-shell {
		background-color: var(--event-page-background-dark, #141228);
		background-image:
			var(--event-background-overlay-dark, none), var(--event-background-image, none);
		color: rgba(244, 243, 255, 0.95);
	}

	.top-nav {
		background: rgba(252, 250, 255, 0.94);
		border-bottom-color: rgba(122, 95, 230, 0.12);
		color: #40246b;
		box-shadow: 0 12px 28px rgba(64, 36, 107, 0.08);
	}

	.top-nav.dark-header {
		background: rgba(20, 20, 36, 0.9);
		border-bottom-color: rgba(139, 92, 246, 0.26);
		color: #f6f5ff;
		box-shadow: 0 16px 30px rgba(8, 8, 24, 0.3);
	}

	.top-nav.event-header {
		background: var(--event-header-bg-light, rgba(252, 245, 255, 0.96));
		border-bottom-color: var(--event-header-border-light, rgba(122, 95, 230, 0.22));
		color: var(--event-header-text-light, #312053);
		box-shadow: 0 18px 36px rgba(40, 14, 88, 0.14);
	}

	.top-nav.event-header.dark-header {
		background: var(--event-header-bg-dark, rgba(34, 28, 64, 0.94));
		border-bottom-color: var(--event-header-border-dark, rgba(139, 92, 246, 0.4));
		color: var(--event-header-text-dark, #ffffff);
		box-shadow: 0 18px 36px rgba(8, 6, 28, 0.32);
	}

	.top-nav .brand-link {
		color: inherit;
		text-decoration: none;
		transition: opacity 0.15s ease;
	}

	.top-nav .brand-link:hover {
		opacity: 0.9;
	}

	.top-nav .nav-link,
	.top-nav .nav-icon-button,
	.top-nav .nav-meta {
		color: inherit;
	}

	.nav-link {
		text-decoration: none;
	}

	.nav-icon-button {
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.nav-icon-button:focus-visible,
	.nav-link:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 2px;
	}

	.nav-meta {
		opacity: 0.75;
	}

	.top-nav.event-header .mobile-nav-toggle {
		border-color: var(--event-header-border-light, rgba(122, 95, 230, 0.22));
		background: rgba(255, 255, 255, 0.88);
	}

	.top-nav.event-header .mobile-nav-toggle span {
		background: var(--event-header-text-light, #312053);
	}

	.top-nav.event-header.dark-header .mobile-nav-toggle {
		border-color: var(--event-header-border-dark, rgba(139, 92, 246, 0.4));
		background: rgba(18, 16, 36, 0.6);
	}

	.top-nav.event-header.dark-header .mobile-nav-toggle span {
		background: var(--event-header-text-dark, #ffffff);
	}

	.top-nav.dark-header .nav-meta {
		opacity: 0.8;
	}
</style>
