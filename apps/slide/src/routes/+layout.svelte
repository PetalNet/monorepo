<script lang="ts">
	import '../app.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { children, data } = $props();
	
	let accountDropdownOpen = $state(false);

	// Close dropdown when clicking outside
	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.account-dropdown')) {
			accountDropdownOpen = false;
		}
	}

	async function handleLogout() {
		const response = await fetch('/auth/logout', { method: 'POST' });
		if (response.ok) {
			goto('/');
		}
	}

	// Determine if we should show the nav bar
	let showNav = $derived(data.user && !$page.url.pathname.startsWith('/auth') && $page.url.pathname !== '/');
</script>

<svelte:head>
	<title>SlideNight - Presentation Night Platform</title>
	<meta name="description" content="Run structured presentation nights with live judging" />
</svelte:head>

<svelte:window onclick={handleClickOutside} />

<div class="min-h-screen bg-theater-darker">
	{#if showNav}
		<!-- Top Navigation Bar -->
		<nav class="bg-theater-dark border-b border-gray-800 sticky top-0 z-50">
			<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
				<div class="flex justify-between items-center h-16">
					<!-- Logo/Brand -->
					<button 
						onclick={() => goto('/dashboard')}
						class="flex items-center gap-2 text-xl font-bold text-white hover:text-purple-400 transition"
					>
						<span class="text-2xl">🎤</span>
						<span>SlideNight</span>
					</button>

					<!-- Right Side - Account Dropdown -->
					<div class="relative account-dropdown">
						<button
							onclick={() => accountDropdownOpen = !accountDropdownOpen}
							class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-800 transition"
						>
							<div class="w-8 h-8 rounded-full bg-theater-purple flex items-center justify-center text-white font-semibold">
								{data.user?.name?.charAt(0).toUpperCase()}
							</div>
							<span class="text-white hidden sm:inline">{data.user?.name}</span>
							<svg 
								class="w-4 h-4 text-gray-400 transition-transform {accountDropdownOpen ? 'rotate-180' : ''}" 
								fill="none" 
								stroke="currentColor" 
								viewBox="0 0 24 24"
							>
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
							</svg>
						</button>

						{#if accountDropdownOpen}
							<div class="absolute right-0 mt-2 w-56 bg-theater-dark border border-gray-800 rounded-lg shadow-xl py-2">
								<!-- User Info -->
								<div class="px-4 py-3 border-b border-gray-800">
									<p class="text-sm text-white font-semibold">{data.user?.name}</p>
									<p class="text-xs text-gray-400 truncate">{data.user?.email}</p>
								</div>

								<!-- Menu Items -->
								<button
									onclick={() => {
										accountDropdownOpen = false;
										goto('/dashboard');
									}}
									class="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition flex items-center gap-2"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path>
									</svg>
									Dashboard
								</button>

								<button
									onclick={() => {
										accountDropdownOpen = false;
										goto('/settings');
									}}
									class="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition flex items-center gap-2"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
									</svg>
									Settings
								</button>

								<div class="border-t border-gray-800 my-2"></div>

								<button
									onclick={handleLogout}
									class="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-gray-800 hover:text-red-300 transition flex items-center gap-2"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
									</svg>
									Log Out
								</button>
							</div>
						{/if}
					</div>
				</div>
			</div>
		</nav>
	{/if}

	<div class="min-h-screen">
		{@render children?.()}
	</div>
</div>
