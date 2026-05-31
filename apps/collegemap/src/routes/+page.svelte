<script lang="ts">
	import { onMount } from 'svelte';
	import Map from '$lib/components/Map.svelte';
	import Timeline from '$lib/components/Timeline.svelte';
	import ExportButton from '$lib/components/ExportButton.svelte';
	import 'leaflet/dist/leaflet.css';
	import 'leaflet.markercluster/dist/MarkerCluster.css';
	import { getLogoUrl } from '$lib/collegeLogos';

	type UserWithCollege = {
		id: string;
		firstName: string;
		lastName: string;
		createdAt: string;
		college: {
			id: string;
			name: string;
			latitude: number;
			longitude: number;
		};
	};

	let { data } = $props();

	// Live users (reactive copy seeded from SSR, updated via SSE)
	const initialUsers = data.users;
	let liveUsers: UserWithCollege[] = $state(initialUsers);

	// Recompute live rankings from liveUsers
	let liveRankings = $derived.by(() => {
		const countMap = new globalThis.Map<string, { name: string; count: number }>();
		for (const u of liveUsers) {
			const existing = countMap.get(u.college.id);
			if (existing) {
				existing.count++;
			} else {
				countMap.set(u.college.id, { name: u.college.name, count: 1 });
			}
		}
		return Array.from(countMap.values()).sort((a, b) => b.count - a.count);
	});

	// Timeline state
	let timelineActive = $state(false);
	let timelineFilteredUsers: UserWithCollege[] = $state([]);

	// Display users: filtered by timeline if active, else all live users
	let displayUsers = $derived(timelineActive ? timelineFilteredUsers : liveUsers);

	// Derive unique college count from display users
	let displayCollegeCount = $derived(
		new Set(displayUsers.map((u) => u.college.id)).size
	);

	// Map instance ref for export
	let mapInstance: import('leaflet').Map | null = $state(null);

	let showLeaderboard = $state(false);
	let searchQuery = $state('');
	let maxCount = $derived(
		liveRankings.length > 0 ? liveRankings[0].count : 1
	);

	// View mode toggle
	let viewMode: 'markers' | 'heat' = $state('markers');

	// Selected college for fly-to
	let selectedCollege: { name: string; latitude: number; longitude: number } | null = $state(null);

	// Search dropdown state
	let searchFocused = $state(false);
	let highlightedIndex = $state(-1);
	let searchInputEl: HTMLInputElement;

	let searchResults = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return [];
		return liveRankings
			.filter((c) => c.name.toLowerCase().includes(q))
			.slice(0, 8);
	});

	let showDropdown = $derived(searchFocused && searchQuery.trim().length > 0 && searchResults.length > 0);

	function selectCollege(college: { name: string; count: number }) {
		const user = liveUsers.find((u) => u.college.name === college.name);
		if (user) {
			const target = {
				name: college.name,
				latitude: user.college.latitude,
				longitude: user.college.longitude
			};
			selectedCollege = null;
			queueMicrotask(() => {
				selectedCollege = target;
			});
		}
		searchQuery = '';
		searchFocused = false;
		highlightedIndex = -1;
		searchInputEl?.blur();
	}

	function handleSearchKeydown(e: KeyboardEvent) {
		if (!showDropdown) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightedIndex = Math.min(highlightedIndex + 1, searchResults.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlightedIndex = Math.max(highlightedIndex - 1, 0);
		} else if (e.key === 'Enter' && highlightedIndex >= 0) {
			e.preventDefault();
			selectCollege(searchResults[highlightedIndex]);
		} else if (e.key === 'Escape') {
			searchFocused = false;
			highlightedIndex = -1;
			searchInputEl?.blur();
		}
	}

	// Reset highlight when results change
	$effect(() => {
		void searchResults;
		highlightedIndex = -1;
	});

	// SSE connection for real-time updates
	onMount(() => {
		const es = new EventSource('/api/events');
		es.addEventListener('user-added', (e) => {
			try {
				const user = JSON.parse(e.data) as UserWithCollege;
				// Replace if user already exists (college change), else append
				const idx = liveUsers.findIndex((u) => u.id === user.id);
				if (idx >= 0) {
					liveUsers[idx] = user;
				} else {
					liveUsers.push(user);
				}
				// Trigger reactivity
				liveUsers = liveUsers;
			} catch {
				// ignore parse errors
			}
		});
		return () => es.close();
	});
</script>

<svelte:head>
	<title>{data.mapName}</title>
</svelte:head>

<div class="page-root">
	<!-- Header -->
	<header class="header">
		<div class="header-left">
			<svg class="header-icon" width="22" height="22" viewBox="0 0 24 24" fill="none">
				<circle cx="12" cy="12" r="10" stroke="url(#grad)" stroke-width="2"/>
				<circle cx="12" cy="10" r="3" fill="url(#grad)"/>
				<path d="M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="url(#grad)" stroke-width="2" stroke-linecap="round"/>
				<defs>
					<linearGradient id="grad" x1="0" y1="0" x2="24" y2="24">
						<stop stop-color="#6366f1"/>
						<stop offset="1" stop-color="#0ea5e9"/>
					</linearGradient>
				</defs>
			</svg>
			<h1 class="header-title">{data.mapName}</h1>
		</div>

		<div class="header-right">
			<button
				class="btn-outline btn-leaderboard"
				onclick={() => showLeaderboard = !showLeaderboard}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="3" y="12" width="5" height="9" rx="1"/>
					<rect x="10" y="3" width="5" height="18" rx="1"/>
					<rect x="17" y="8" width="5" height="13" rx="1"/>
				</svg>
				<span class="leaderboard-label">Leaderboard</span>
			</button>

			{#if data.user}
				<span class="user-name">
					{data.user.firstName} {data.user.lastName}
				</span>
				{#if !data.user.hasCollege}
					<a href="/profile" class="btn-primary">Set Your College</a>
				{:else}
					<a href="/profile" class="btn-outline">Profile</a>
				{/if}
			{:else}
				<a href="/login" class="btn-outline">Log In</a>
				<a href="/signup" class="btn-primary">Sign Up</a>
			{/if}
		</div>
	</header>

	<!-- Map -->
	<main class="map-area">
		<Map users={displayUsers} {viewMode} {selectedCollege} onMapReady={(m) => mapInstance = m} />

		<!-- Search Bar -->
		<div class="search-container">
			<svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="11" cy="11" r="8"/>
				<path d="m21 21-4.35-4.35"/>
			</svg>
			<input
				bind:this={searchInputEl}
				type="text"
				placeholder="Search colleges..."
				class="search-input"
				bind:value={searchQuery}
				onfocus={() => searchFocused = true}
				onblur={() => { setTimeout(() => { searchFocused = false; }, 150); }}
				onkeydown={handleSearchKeydown}
				role="combobox"
				aria-expanded={showDropdown}
				aria-autocomplete="list"
				aria-controls="search-dropdown"
			/>

			{#if showDropdown}
				<div class="search-dropdown" id="search-dropdown" role="listbox">
					{#each searchResults as college, i (college.name)}
						{@const logoUrl = getLogoUrl(college.name, 32)}
						<button
							class="search-result"
							class:highlighted={i === highlightedIndex}
							role="option"
							aria-selected={i === highlightedIndex}
							onmousedown={(e) => { e.preventDefault(); selectCollege(college); }}
							onmouseenter={() => highlightedIndex = i}
						>
							{#if logoUrl}
								<img class="search-result-logo" src={logoUrl} alt="" width="20" height="20" onerror={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }} />
							{:else}
								<div class="search-result-logo-placeholder">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
								</div>
							{/if}
							<span class="search-result-name">{college.name}</span>
							<span class="search-result-count">{college.count}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Stats -->
		<div class="stats-overlay">
			<div class="stats-number">{displayUsers.length}</div>
			<div class="stats-label">{displayUsers.length === 1 ? 'person' : 'people'} on the map</div>
			<div class="stats-sub">{displayCollegeCount} {displayCollegeCount === 1 ? 'college' : 'colleges'}</div>
		</div>

		<!-- View Mode Toggle -->
		<div class="view-toggle">
			<button
				class="view-toggle-btn"
				class:active={viewMode === 'markers'}
				aria-label="Show markers"
				onclick={() => viewMode = 'markers'}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
					<circle cx="12" cy="10" r="3"/>
				</svg>
			</button>
			<button
				class="view-toggle-btn"
				class:active={viewMode === 'heat'}
				aria-label="Show heat map"
				onclick={() => viewMode = 'heat'}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 22c-4.97 0-9-2.69-9-6 0-2.37 2.33-4.46 4-5.5 0 0 1.5 2.5 3 2.5 1.11 0 1-1.5 1-1.5s2.5 1.5 2.5 4c0 1.1-.4 2.1-1 2.8.6-.3 1.2-1 1.5-1.8.5 1.1 1 2.3 1 3.5 0 3.31-1.03 2-3 2z"/>
					<path d="M12 14c-1 0-2.5-2-2.5-2s.5 3-1 4"/>
				</svg>
			</button>
			<div class="view-toggle-divider"></div>
			<button
				class="view-toggle-btn"
				class:active={timelineActive}
				aria-label="Toggle timeline"
				onclick={() => timelineActive = !timelineActive}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10"/>
					<polyline points="12 6 12 12 16 14"/>
				</svg>
			</button>
			<ExportButton mapInstance={mapInstance} mapName={data.mapName} />
		</div>

		<!-- Timeline -->
		{#if timelineActive}
			<Timeline users={liveUsers} onFilteredUsersChange={(f) => timelineFilteredUsers = f} />
		{/if}

		<!-- Leaderboard -->
		{#if showLeaderboard}
			<div class="lb-overlay" onclick={() => showLeaderboard = false} role="presentation"></div>
			<aside class="lb-sidebar">
				<div class="lb-header">
					<h2 class="lb-title">Top Colleges</h2>
					<button class="lb-close" aria-label="Close leaderboard" onclick={() => showLeaderboard = false}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M18 6 6 18M6 6l12 12"/>
						</svg>
					</button>
				</div>

				<div class="lb-list">
					{#if searchQuery.trim()}
						{@const filtered = liveRankings.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))}
						{#each filtered as college, i (college.name)}
							{@const logoUrl = getLogoUrl(college.name, 32)}
							<div class="lb-item" style="animation-delay: {i * 40}ms">
								<div class="lb-rank">#{liveRankings.indexOf(college) + 1}</div>
								{#if logoUrl}
									<img class="lb-logo" src={logoUrl} alt="" width="20" height="20" onerror={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }} />
								{/if}
								<div class="lb-info">
									<div class="lb-name">{college.name}</div>
									<div class="lb-bar-track">
										<div class="lb-bar-fill" style="width: {(college.count / maxCount) * 100}%"></div>
									</div>
								</div>
								<div class="lb-count">{college.count}</div>
							</div>
						{/each}
						{#if filtered.length === 0}
							<div class="lb-empty">No colleges match "{searchQuery}"</div>
						{/if}
					{:else}
						{#each liveRankings as college, i (college.name)}
							{@const logoUrl = getLogoUrl(college.name, 32)}
							<div class="lb-item" style="animation-delay: {i * 40}ms">
								<div class="lb-rank">#{i + 1}</div>
								{#if logoUrl}
									<img class="lb-logo" src={logoUrl} alt="" width="20" height="20" onerror={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }} />
								{/if}
								<div class="lb-info">
									<div class="lb-name">{college.name}</div>
									<div class="lb-bar-track">
										<div class="lb-bar-fill" style="width: {(college.count / maxCount) * 100}%"></div>
									</div>
								</div>
								<div class="lb-count">{college.count}</div>
							</div>
						{/each}
					{/if}

					{#if liveRankings.length === 0}
						<div class="lb-empty">No colleges yet. Be the first!</div>
					{/if}
				</div>
			</aside>
		{/if}
	</main>
</div>

<style>
	.page-root {
		display: flex;
		flex-direction: column;
		height: 100vh;
		height: 100dvh;
		background: var(--bg-page);
	}

	/* Header */
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		background: var(--bg-card-alpha);
		backdrop-filter: blur(12px);
		border-bottom: 1px solid var(--border-card);
		z-index: 1000;
		position: relative;
		gap: 8px;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.header-icon {
		flex-shrink: 0;
	}

	.header-title {
		font-size: 1.1rem;
		font-weight: 700;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.user-name {
		font-size: 0.8rem;
		color: var(--text-secondary);
		display: none;
	}

	@media (min-width: 640px) {
		.user-name {
			display: inline;
		}
	}

	/* Buttons */
	.btn-primary {
		padding: 7px 14px;
		border-radius: 8px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-on-accent);
		background: var(--accent);
		transition: opacity 0.2s;
		text-decoration: none;
		white-space: nowrap;
	}

	.btn-primary:hover {
		opacity: 0.9;
	}

	.btn-outline {
		padding: 7px 14px;
		border-radius: 8px;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-secondary);
		background: var(--accent-bg);
		border: 1px solid var(--border-card);
		transition: all 0.2s;
		text-decoration: none;
		cursor: pointer;
		white-space: nowrap;
	}

	.btn-outline:hover {
		background: var(--accent-bg-hover);
		color: var(--text-primary);
	}

	.btn-leaderboard {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--accent);
		border-color: var(--border-accent);
	}

	.leaderboard-label {
		display: none;
	}

	@media (min-width: 480px) {
		.leaderboard-label {
			display: inline;
		}
	}

	/* Map */
	.map-area {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	/* Search */
	.search-container {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 1000;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		width: calc(100% - 24px);
		max-width: 340px;
		animation: slide-up 0.4s ease;
	}

	.search-icon {
		position: absolute;
		left: 12px;
		top: 12px;
		color: var(--text-muted);
		pointer-events: none;
	}

	.search-input {
		width: 100%;
		padding: 9px 14px 9px 36px;
		border-radius: 10px;
		background: var(--bg-card-alpha);
		backdrop-filter: blur(12px);
		border: 1px solid var(--border-card);
		color: var(--text-primary);
		font-size: 0.85rem;
		font-family: 'Inter', sans-serif;
		outline: none;
		transition: border-color 0.2s;
	}

	.search-input::placeholder {
		color: var(--text-muted);
	}

	.search-input:focus {
		border-color: var(--accent);
	}

	/* Search Dropdown */
	.search-dropdown {
		margin-top: 4px;
		border-radius: 10px;
		background: var(--bg-card-alpha);
		backdrop-filter: blur(16px);
		border: 1px solid var(--border-card);
		overflow: hidden;
		animation: slide-up 0.2s ease;
	}

	.search-result {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 12px;
		border: none;
		background: transparent;
		color: var(--text-primary);
		font-family: 'Inter', sans-serif;
		font-size: 0.82rem;
		cursor: pointer;
		transition: background 0.1s;
		text-align: left;
	}

	.search-result:not(:last-child) {
		border-bottom: 1px solid var(--border-subtle);
	}

	.search-result:hover,
	.search-result.highlighted {
		background: var(--accent-bg);
	}

	.search-result-logo {
		border-radius: 4px;
		flex-shrink: 0;
	}

	.search-result-logo-placeholder {
		width: 20px;
		height: 20px;
		border-radius: 4px;
		background: var(--accent-bg);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.search-result-name {
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-weight: 500;
	}

	.search-result-count {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--accent);
		flex-shrink: 0;
	}

	/* View Mode Toggle */
	.view-toggle {
		position: absolute;
		bottom: 12px;
		right: 12px;
		z-index: 1000;
		display: flex;
		gap: 2px;
		padding: 3px;
		border-radius: 10px;
		background: var(--bg-card-alpha);
		backdrop-filter: blur(12px);
		border: 1px solid var(--border-card);
		animation: slide-up 0.5s ease;
	}

	.view-toggle-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border-radius: 8px;
		border: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition: all 0.2s;
	}

	.view-toggle-btn:hover {
		color: var(--text-primary);
		background: var(--accent-bg);
	}

	.view-toggle-btn.active {
		color: var(--accent);
		background: var(--accent-bg);
	}

	.view-toggle-divider {
		width: 1px;
		height: 20px;
		background: var(--border-card);
		margin: 0 2px;
	}

	/* Stats */
	.stats-overlay {
		position: absolute;
		bottom: 12px;
		left: 12px;
		z-index: 1000;
		padding: 12px 16px;
		border-radius: 10px;
		background: var(--bg-card-alpha);
		backdrop-filter: blur(12px);
		border: 1px solid var(--border-card);
		animation: slide-up 0.5s ease;
	}

	.stats-number {
		font-size: 1.5rem;
		font-weight: 800;
		color: var(--accent);
		line-height: 1;
	}

	.stats-label {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 1px;
	}

	.stats-sub {
		font-size: 0.7rem;
		color: var(--text-muted);
		margin-top: 2px;
	}

	/* Leaderboard */
	.lb-overlay {
		position: absolute;
		inset: 0;
		z-index: 1001;
		background: rgba(0, 0, 0, 0.2);
	}

	.lb-sidebar {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 100%;
		max-width: 360px;
		z-index: 1002;
		background: var(--bg-card-alpha);
		backdrop-filter: blur(16px);
		border-left: 1px solid var(--border-card);
		display: flex;
		flex-direction: column;
		animation: slideIn 0.25s ease;
	}

	@keyframes slideIn {
		from { transform: translateX(100%); }
		to { transform: translateX(0); }
	}

	.lb-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px;
		border-bottom: 1px solid var(--border-card);
		flex-shrink: 0;
	}

	.lb-title {
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.lb-close {
		color: var(--text-muted);
		cursor: pointer;
		background: none;
		border: none;
		padding: 4px;
		border-radius: 6px;
		transition: color 0.2s;
	}

	.lb-close:hover {
		color: var(--text-primary);
	}

	.lb-list {
		overflow-y: auto;
		flex: 1;
	}

	.lb-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--border-subtle);
		animation: slide-up 0.25s ease both;
		transition: background 0.15s;
	}

	.lb-item:hover {
		background: var(--accent-bg);
	}

	.lb-rank {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text-muted);
		min-width: 26px;
	}

	.lb-logo {
		border-radius: 4px;
		flex-shrink: 0;
	}

	.lb-info {
		flex: 1;
		min-width: 0;
	}

	.lb-name {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		margin-bottom: 4px;
	}

	.lb-bar-track {
		height: 3px;
		border-radius: 2px;
		background: var(--accent-bg);
		overflow: hidden;
	}

	.lb-bar-fill {
		height: 100%;
		border-radius: 2px;
		background: var(--accent);
		transition: width 0.5s ease;
	}

	.lb-count {
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--accent);
		min-width: 20px;
		text-align: right;
	}

	.lb-empty {
		padding: 32px 16px;
		text-align: center;
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	@keyframes slide-up {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
