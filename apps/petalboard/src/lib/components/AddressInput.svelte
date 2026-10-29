<script lang="ts">
	import { env } from "$env/dynamic/public";
	import { loadGoogleMaps } from "$lib/utils/googleMaps";
	import { onMount, onDestroy } from "svelte";

	let {
		value = $bindable(""),
		error = "",
		name = "location",
	}: {
		value?: string;
		error?: string;
		name?: string;
	} = $props();

	let inputElement = $state<HTMLInputElement>();
	let mapElement = $state<HTMLDivElement>();
	let map: google.maps.Map | null = null;
	let marker: google.maps.marker.AdvancedMarkerElement | null = null;
	let showMap = $state(false);
	let isLoading = $state(false);
	let loadError = $state("");
	let suggestions = $state<any[]>([]);
	let showSuggestions = $state(false);
	let selectedIndex = $state(-1);
	let sessionToken: google.maps.places.AutocompleteSessionToken | null = null;

	const apiKey = env.PUBLIC_GOOGLE_MAPS_API_KEY;

	onMount(async () => {
		if (!apiKey || apiKey === "your-google-maps-api-key") {
			loadError = "Google Maps API key not configured";

			return;
		}

		try {
			isLoading = true;
			await loadGoogleMaps(apiKey);
			initializeAutocomplete();
			isLoading = false;
		} catch (err) {
			console.error("Failed to load Google Maps:", err);
			loadError = "Failed to load address autocomplete";
			isLoading = false;
		}
	});

	function initializeAutocomplete() {
		if (!window.google?.maps?.places) {
			return;
		}

		// Create a new session token for autocomplete requests
		sessionToken = new google.maps.places.AutocompleteSessionToken();
	}

	async function handleInput() {
		if (!value || value.length < 3) {
			suggestions = [];
			showSuggestions = false;

			return;
		}

		try {
			// Use the new AutocompleteSuggestion API
			const request = {
				input: value,
				includedPrimaryTypes: ["street_address", "route", "premise"],
				sessionToken: sessionToken!,
			};

			const { suggestions: results } =
				await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(request);

			suggestions = results || [];
			showSuggestions = suggestions.length > 0;
			selectedIndex = -1;
		} catch (err) {
			console.error("Autocomplete error:", err);
			suggestions = [];
			showSuggestions = false;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!showSuggestions || suggestions.length === 0) {
			return;
		}

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);

				break;
			case "ArrowUp":
				event.preventDefault();
				selectedIndex = Math.max(selectedIndex - 1, -1);

				break;
			case "Enter":
				event.preventDefault();

				if (selectedIndex >= 0) {
					selectSuggestion(suggestions[selectedIndex]);
				}

				break;
			case "Escape":
				showSuggestions = false;
				selectedIndex = -1;

				break;
		}
	}

	async function selectSuggestion(suggestion: any) {
		value = suggestion.placePrediction.text.text;
		showSuggestions = false;
		selectedIndex = -1;

		// Create a new session token for the next search
		sessionToken = new google.maps.places.AutocompleteSessionToken();

		// Get place details using the new Place API
		try {
			const place = suggestion.placePrediction.toPlace();

			await place.fetchFields({
				fields: ["displayName", "formattedAddress", "location"],
			});

			const location = place.location;

			if (location) {
				showMap = true;

				// Wait for next tick to ensure mapElement is rendered
				await new Promise((resolve) => setTimeout(resolve, 0));

				if (!map && mapElement) {
					const { Map } = await google.maps.importLibrary("maps");
					const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

					map = new Map(mapElement, {
						center: location,
						zoom: 15,
						mapId: "DEMO_MAP_ID", // Required for AdvancedMarkerElement
						mapTypeControl: false,
						streetViewControl: false,
						fullscreenControl: false,
					});

					marker = new AdvancedMarkerElement({
						map: map,
						position: location,
					});
				} else if (map && marker) {
					map.setCenter(location);
					marker.position = location;
				}
			}
		} catch (err) {
			console.error("Failed to get place details:", err);
		}
	}

	function clearLocation() {
		value = "";
		showMap = false;
		showSuggestions = false;
		suggestions = [];

		if (marker) {
			marker.map = null;
			marker = null;
		}

		if (map) {
			map = null;
		}

		// Create new session token
		sessionToken = new google.maps.places.AutocompleteSessionToken();
	}

	function handleBlur() {
		// Delay hiding suggestions to allow clicking on them
		setTimeout(() => {
			showSuggestions = false;
			selectedIndex = -1;
		}, 200);
	}

	onDestroy(() => {
		if (marker) {
			marker.map = null;
		}
	});
</script>

<div class="flex flex-col gap-3">
	<div class="relative w-full">
		<input
			bind:this={inputElement}
			bind:value
			{name}
			type="text"
			placeholder={loadError
				? "Enter location (e.g., '123 Main St' or 'Online')"
				: "Start typing an address..."}
			class="font-inherit w-full rounded-xl border px-4 py-3 pr-10 text-dark-900 transition-all focus:bg-white focus:outline-none"
			class:border-red-600={error}
			class:focus:shadow-[0_0_0_3px_rgba(194,59,75,0.18)]={error}
			class:border-primary-700={!error}
			class:focus:border-primary-700={!error}
			class:focus:shadow-[0_0_0_3px_rgba(124,93,250,0.18)]={!error}
			style="background: rgba(255, 255, 255, 0.9);"
			style:color="rgba(42, 23, 72, 0.5)"
			oninput={handleInput}
			onkeydown={handleKeydown}
			onblur={handleBlur}
			autocomplete="off"
		/>

		{#if value && !isLoading}
			<button
				type="button"
				class="address-clear-btn"
				onclick={clearLocation}
				aria-label="Clear address"
				onfocus={() => (selectedIndex = -1)}
			>
				✕
			</button>
		{/if}
		{#if isLoading}
			<span class="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-xl text-primary-700"
				>⟳</span
			>
		{/if}

		{#if showSuggestions && suggestions.length > 0}
			<div class="address-suggestion-list" style="border-color: rgba(124, 93, 250, 0.25);">
				{#each suggestions as suggestion, index}
					<button
						type="button"
						class="address-suggestion"
						class:selected={index === selectedIndex}
						onclick={() => selectSuggestion(suggestion)}
						onfocus={() => (selectedIndex = index)}
						onmouseenter={() => (selectedIndex = index)}
						onblur={() => {
							if (selectedIndex === index) {
								selectedIndex = -1;
							}
						}}
						onmouseleave={() => {
							if (selectedIndex === index) {
								selectedIndex = -1;
							}
						}}
					>
						<div class="mb-1 font-medium text-dark-900">{suggestion.placePrediction.text.text}</div>
						{#if suggestion.placePrediction.structuredFormat?.secondaryText?.text}
							<div class="text-sm" style="color: rgba(42, 23, 72, 0.6);">
								{suggestion.placePrediction.structuredFormat.secondaryText.text}
							</div>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if error}
		<small class="text-sm text-red-600">{error}</small>
	{/if}

	{#if loadError}
		<small class="text-sm text-orange-600"
			>{loadError}. You can still enter a location manually.</small
		>
	{/if}

	{#if showMap && !loadError}
		<div
			class="relative overflow-hidden rounded-2xl bg-white shadow-[0_8px_24px_rgba(60,35,110,0.12)]"
		>
			<div bind:this={mapElement} class="h-[300px] w-full"></div>
			<div
				class="absolute bottom-4 left-4 right-4 flex items-center gap-2 rounded-xl p-3 px-4 shadow-[0_4px_12px_rgba(0,0,0,0.1)] backdrop-blur-sm"
				style="background-color: rgba(255, 255, 255, 0.95);"
			>
				<span class="flex-shrink-0 text-xl">📍</span>
				<span
					class="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-dark-900"
					>{value}</span
				>
			</div>
		</div>
	{/if}
</div>

<style>
	@keyframes spin {
		from {
			transform: translateY(-50%) rotate(0deg);
		}
		to {
			transform: translateY(-50%) rotate(360deg);
		}
	}

	.animate-spin {
		animation: spin 1s linear infinite;
	}
</style>
