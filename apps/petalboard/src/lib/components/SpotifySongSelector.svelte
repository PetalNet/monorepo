<script lang="ts">
  import type { SpotifyTrack } from '$lib/server/spotify';

  interface Props {
    value?: string;
    name: string;
    required?: boolean;
    eventCode?: string; // Optional: for guest RSVP, uses host's token
    limit?: number | null;
    playlistId?: string | null; // Spotify playlist ID for removing tracks
    questionId?: string; // Question ID for tracking
  }

  let { value = '', name, required = false, eventCode, limit = null, playlistId = null, questionId }: Props = $props();

  let searchQuery = $state('');
  let searchResults = $state<SpotifyTrack[]>([]);
  let isSearching = $state(false);
  let selectedTracks = $state<SpotifyTrack[]>([]);
  let initialTracks = $state<Set<string>>(new Set()); // Track IDs that were there initially
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  let showResults = $state(false);
  let lastValue = $state<string | null>(null);

  const limitReached = $derived(limit !== null && limit !== undefined && selectedTracks.length >= limit);

  function parseValue(raw: string | null | undefined) {
    if (!raw) {
      selectedTracks = [];
      initialTracks = new Set();
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        selectedTracks = parsed;
        // Store initial track IDs
        initialTracks = new Set(parsed.map((t: SpotifyTrack) => t.id));
      } else if (parsed && typeof parsed === 'object') {
        selectedTracks = [parsed as SpotifyTrack];
        initialTracks = new Set([parsed.id]);
      }
    } catch (error) {
      console.warn('Failed to parse Spotify selection', error);
    }
  }

  // Parse existing value if provided or updated from parent form
  $effect(() => {
    if (value !== lastValue) {
      const next = value ?? '';
      parseValue(next);
      lastValue = next;
    }
  });

  async function handleSearch() {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      searchResults = [];
      return;
    }

    isSearching = true;
    showResults = true;

    try {
      const url = eventCode
        ? `/api/spotify/search?q=${encodeURIComponent(searchQuery)}&eventCode=${encodeURIComponent(eventCode)}`
        : `/api/spotify/search?q=${encodeURIComponent(searchQuery)}`;

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        searchResults = data.tracks.items;
      } else {
        searchResults = [];
      }
    } catch (error) {
      console.error('Search error:', error);
      searchResults = [];
    } finally {
      isSearching = false;
    }
  }

  function debounceSearch(query: string) {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    searchTimeout = setTimeout(() => {
      handleSearch();
    }, 300);
  }

  function selectTrack(track: SpotifyTrack) {
    if (limitReached) {
      return;
    }

    if (!selectedTracks.some((selected) => selected.id === track.id)) {
      selectedTracks = [...selectedTracks, track];
    }
    showResults = false;
    searchQuery = '';
    searchResults = [];
  }

  function removeTrack(trackId: string) {
    const track = selectedTracks.find(t => t.id === trackId);
    selectedTracks = selectedTracks.filter((track) => track.id !== trackId);
    
    // Only remove from Spotify if it was added in this session (not there initially)
    if (playlistId && track?.uri && questionId && !initialTracks.has(trackId)) {
      removeTrackFromSpotify(track.uri);
    }
  }

  async function removeTrackFromSpotify(trackUri: string) {
    try {
      const response = await fetch('/api/spotify/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playlistId,
          trackUri,
          questionId,
          eventCode
        })
      });

      if (!response.ok) {
        console.error('Failed to remove track from Spotify playlist');
      }
    } catch (error) {
      console.error('Error removing track from Spotify:', error);
    }
  }

  function handleInputChange(event: Event) {
    const target = event.target as HTMLInputElement;
    searchQuery = target.value;
    debounceSearch(target.value);
  }
</script>

<div class="space-y-3">
  <!-- Hidden input with JSON value -->
  <input
    type="hidden"
    {name}
    value={selectedTracks.length > 0 ? JSON.stringify(selectedTracks) : ''}
    {required}
  />

  {#if selectedTracks.length > 0}
    <div class="space-y-3">
      {#each selectedTracks as track (track.id)}
        <div class="bg-gradient-to-br from-primary-50 to-accent-50/30 rounded-xl p-4 border border-primary-700/20">
          <div class="flex gap-4 items-start">
            {#if track.album.images[0]}
              <img
                src={track.album.images[2]?.url || track.album.images[0].url}
                alt={track.album.name}
                class="w-16 h-16 rounded-lg shadow-md shrink-0 object-cover"
                loading="lazy"
                decoding="async"
                width="64"
                height="64"
              />
            {/if}
            <div class="flex-1 min-w-0 py-1">
              <h4 class="text-sm font-semibold text-dark-900 truncate">{track.name}</h4>
              <p class="text-xs text-dark-700/70 truncate">
                {track.artists.map((artist) => artist.name).join(', ')}
              </p>
            </div>
            <button
              type="button"
              onclick={() => removeTrack(track.id)}
              class="px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-red-50 text-red-600 hover:bg-red-100 shrink-0"
            >
              Remove
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="space-y-2">
    <div class="relative">
      <input
        type="text"
        class="input-field"
        placeholder={limit ? `Search for a song... (${selectedTracks.length}/${limit})` : 'Search for a song...'}
        value={searchQuery}
        oninput={handleInputChange}
        onfocus={() => {
          if (searchResults.length > 0) showResults = true;
        }}
        disabled={limitReached}
      />

      {#if isSearching}
        <div class="absolute right-3 top-1/2 -translate-y-1/2">
          <div class="w-5 h-5 border-2 border-primary-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {/if}

      <!-- Search Results Dropdown -->
      {#if showResults && searchResults.length > 0}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="fixed inset-0 z-10"
          onclick={() => {
            showResults = false;
          }}
        ></div>
        <div class="absolute z-20 mt-2 w-full bg-white rounded-xl shadow-2xl border border-primary-700/10 max-h-96 overflow-y-auto">
          {#each searchResults as track (track.id)}
            <button
              type="button"
              class="w-full p-3 flex gap-3 items-center hover:bg-primary-50 transition-colors text-left border-b border-gray-100 last:border-b-0 disabled:opacity-60 disabled:cursor-not-allowed"
              onclick={() => selectTrack(track)}
              disabled={limitReached && !selectedTracks.some((selected) => selected.id === track.id)}
            >
              {#if track.album.images[2]}
                <img
                  src={track.album.images[2].url}
                  alt={track.album.name}
                  class="w-12 h-12 rounded shadow-sm"
                  loading="lazy"
                  decoding="async"
                  width="48"
                  height="48"
                />
              {/if}
              <div class="flex-1 min-w-0">
                <div class="font-medium text-dark-900 truncate">{track.name}</div>
                <div class="text-sm text-dark-700/70 truncate">
                  {track.artists.map((artist) => artist.name).join(', ')}
                </div>
                <div class="text-xs text-dark-700/50 truncate">{track.album.name}</div>
              </div>
              <div class="text-2xl">{selectedTracks.some((selected) => selected.id === track.id) ? '✅' : '🎵'}</div>
            </button>
          {/each}
        </div>
      {/if}

      {#if showResults && searchQuery && searchResults.length === 0 && !isSearching}
        <div class="absolute z-20 mt-2 w-full bg-white rounded-xl shadow-2xl border border-primary-700/10 p-4 text-center text-gray-500">
          No songs found
        </div>
      {/if}
    </div>

    {#if limitReached}
      <p class="text-xs font-medium text-primary-700">You've reached the maximum of {limit} song{limit === 1 ? '' : 's'}.</p>
    {:else if limit}
      <p class="text-xs text-gray-600">{limit - selectedTracks.length} song{limit - selectedTracks.length === 1 ? '' : 's'} remaining.</p>
    {:else}
      <p class="text-xs text-gray-600">Add as many songs as you like.</p>
    {/if}
  </div>
</div>
