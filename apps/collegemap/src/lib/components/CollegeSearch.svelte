<script lang="ts">
	import { collegeNames } from '$lib/collegeNames';
	import collegesJson from '$lib/colleges.json';
	import { getLogoUrl } from '$lib/collegeLogos';

	interface SelectedCollege {
		name: string;
		latitude: number;
		longitude: number;
		isCustom: boolean;
	}

	interface PreseededCollege {
		name: string;
		lat: number;
		lng: number;
	}

	let {
		onselect,
		placeholder = 'Search for your college...',
		inputId = 'college-search'
	}: {
		onselect: (college: SelectedCollege) => void;
		placeholder?: string;
		inputId?: string;
	} = $props();

	let query = $state('');
	let results = $state<string[]>([]);
	let showResults = $state(false);
	let selectedIndex = $state(-1);
	let isGeocoding = $state(false);
	let geocodeError = $state('');

	// Build a lookup map from the pre-seeded colleges.json
	const preseededMap = new Map<string, PreseededCollege>();
	for (const college of collegesJson as PreseededCollege[]) {
		preseededMap.set(college.name.toLowerCase(), college);
	}

	function searchLocal(q: string): string[] {
		if (!q.trim() || q.length < 2) return [];
		const lower = q.toLowerCase();
		return collegeNames
			.filter((name) => name.toLowerCase().includes(lower))
			.slice(0, 10);
	}

	async function geocodeCollege(name: string): Promise<{ lat: number; lng: number } | null> {
		try {
			const response = await fetch(`/api/geocode?q=${encodeURIComponent(name)}`);
			if (response.ok) {
				const data = await response.json();
				if (data.length > 0) {
					return { lat: data[0].lat, lng: data[0].lng };
				}
			}
		} catch (e) {
			console.error('Geocoding failed:', e);
		}
		return null;
	}

	async function selectCollege(name: string) {
		isGeocoding = true;
		geocodeError = '';

		// Check pre-seeded coordinates first
		const preseeded = preseededMap.get(name.toLowerCase());
		if (preseeded) {
			onselect({
				name,
				latitude: preseeded.lat,
				longitude: preseeded.lng,
				isCustom: false
			});
			query = name;
			showResults = false;
			results = [];
			isGeocoding = false;
			return;
		}

		// Fall back to geocoding API
		const coords = await geocodeCollege(name);

		if (coords) {
			onselect({
				name,
				latitude: coords.lat,
				longitude: coords.lng,
				isCustom: false
			});
			query = name;
			showResults = false;
			results = [];
		} else {
			geocodeError = 'Could not find location for this college. Try another.';
		}

		isGeocoding = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, -1);
		} else if (e.key === 'Enter' && selectedIndex >= 0) {
			e.preventDefault();
			selectCollege(results[selectedIndex]);
		} else if (e.key === 'Escape') {
			showResults = false;
		}
	}

	function handleInput(e: Event & { currentTarget: HTMLInputElement }) {
		query = e.currentTarget.value;
		results = searchLocal(query);
		selectedIndex = -1;
		geocodeError = '';
	}
</script>

<div class="college-search">
	<input
		id={inputId}
		value={query}
		oninput={handleInput}
		onfocus={() => {
			showResults = true;
			if (query.trim()) {
				results = searchLocal(query);
			}
		}}
		onblur={() => setTimeout(() => (showResults = false), 200)}
		onkeydown={handleKeydown}
		type="text"
		{placeholder}
		disabled={isGeocoding}
		class="cs-input"
	/>

	{#if isGeocoding}
		<div class="spinner-container">
			<div class="spinner"></div>
		</div>
	{/if}

	{#if geocodeError}
		<p class="error-text">{geocodeError}</p>
	{/if}

	{#if showResults && results.length > 0 && !isGeocoding}
		<ul class="dropdown">
			{#each results as name, i (name)}
				{@const logoUrl = getLogoUrl(name, 32)}
				<li>
					<button
						type="button"
						class="dropdown-item"
						class:selected={i === selectedIndex}
						onmousedown={() => selectCollege(name)}
					>
						{#if logoUrl}
							<img class="cs-logo" src={logoUrl} alt="" width="18" height="18" onerror={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }} />
						{:else if preseededMap.has(name.toLowerCase())}
							<svg class="pin-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
								<circle cx="12" cy="10" r="3"/>
							</svg>
						{/if}
						{name}
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if showResults && query.trim().length >= 2 && results.length === 0 && !isGeocoding}
		<div class="dropdown-empty">
			No colleges found matching "{query}"
		</div>
	{/if}
</div>

<style>
	.college-search {
		position: relative;
	}

	.cs-input {
		width: 100%;
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--bg-input);
		border: 1px solid var(--border-card);
		color: var(--text-primary);
		font-size: 0.9rem;
		font-family: 'Inter', sans-serif;
		outline: none;
		transition: border-color 0.2s;
	}

	.cs-input::placeholder {
		color: var(--text-muted);
	}

	.cs-input:focus {
		border-color: var(--accent);
	}

	.cs-input:disabled {
		opacity: 0.6;
	}

	.spinner-container {
		position: absolute;
		right: 12px;
		top: 50%;
		transform: translateY(-50%);
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid var(--border-card);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.error-text {
		margin-top: 5px;
		font-size: 0.8rem;
		color: var(--error-text);
	}

	.dropdown {
		position: absolute;
		z-index: 50;
		margin-top: 4px;
		max-height: 220px;
		width: 100%;
		overflow: auto;
		border-radius: 10px;
		background: var(--bg-card);
		border: 1px solid var(--border-card);
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
		list-style: none;
		padding: 4px;
	}

	.dropdown-item {
		width: 100%;
		padding: 8px 10px;
		text-align: left;
		color: var(--text-primary);
		font-size: 0.85rem;
		font-family: 'Inter', sans-serif;
		background: transparent;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		transition: background 0.15s;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.dropdown-item:hover,
	.dropdown-item.selected {
		background: var(--accent-bg);
	}

	.cs-logo {
		border-radius: 3px;
		flex-shrink: 0;
	}

	.pin-icon {
		color: var(--accent-secondary);
		flex-shrink: 0;
	}

	.dropdown-empty {
		position: absolute;
		z-index: 50;
		margin-top: 4px;
		width: 100%;
		padding: 14px;
		text-align: center;
		border-radius: 10px;
		background: var(--bg-card);
		border: 1px solid var(--border-card);
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
		color: var(--text-muted);
		font-size: 0.85rem;
	}
</style>
