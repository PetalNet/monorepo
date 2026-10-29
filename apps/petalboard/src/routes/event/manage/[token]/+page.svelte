<script lang="ts">
  import { formatDate, formatShortDate } from '$lib/utils/format';
  import type { ActionData, PageData } from './$types';
  import { page } from '$app/stores';
  import { enhance } from '$app/forms';
  import AddressInput from '$lib/components/AddressInput.svelte';
  import { COMMON_TIMEZONES, formatDateTimeForInput } from '$lib/utils/timezones';

  let { data, form } = $props<{ data: PageData; form: ActionData | null }>();
  
  // Check if this is a newly created event
  const isNewlyCreated = $derived($page.url.searchParams.has('new'));

  const eventErrors = $derived<Record<string, string[]>>(
    (form?.type === 'updateEvent' && form.errors ? form.errors : {}) as Record<string, string[]>
  );

  const addSlotErrors = $derived<Record<string, string[]>>(
    (form?.type === 'addQuestion' && form.errors ? form.errors : {}) as Record<string, string[]>
  );

  const slotErrors = $derived<Record<string, Record<string, string[]>>>(
    (() => {
      if (form?.type === 'updateQuestion' && form.errors && form.values?.questionId) {
        return { [form.values.questionId]: form.errors as Record<string, string[]> };
      }
      return {};
    })()
  );

  const eventValues = $derived<Record<string, string>>(
    (form?.type === 'updateEvent' && form.values ? form.values : {}) as Record<string, string>
  );

  const addSlotValues = $derived<Record<string, string>>(
    (form?.type === 'addQuestion' && form.values ? form.values : {}) as Record<string, string>
  );

  const message = $derived<string | null>(form?.message ?? null);

  const successMessage = $derived<string | null>(
    (() => {
      if (!form?.success) return null;
      switch (form.type) {
        case 'updateEvent':
          return 'Event details updated';
        case 'addQuestion':
          return 'Question added';
        case 'updateQuestion':
          return 'Question updated';
        case 'deleteQuestion':
          return 'Question removed';
        case 'deleteRsvp':
          return 'RSVP removed';
        default:
          return null;
      }
    })()
  );

  const event = data.event;
  const rsvps = data.rsvps;

  // Make questions and rsvps reactive so we can update them
  let questions = $state(data.event.questions);
  let rsvpsList = $state(data.rsvps);

  const manageTotalGuests = $derived(rsvpsList.reduce((sum: number, r: typeof rsvpsList[number]) => sum + r.guestCount, 0));
  const manageAttendingRsvps = $derived(rsvpsList.filter((r: typeof rsvpsList[number]) => r.status === 'attending'));
  const manageMaybeRsvps = $derived(rsvpsList.filter((r: typeof rsvpsList[number]) => r.status === 'maybe'));
  const manageNotAttendingRsvps = $derived(rsvpsList.filter((r: typeof rsvpsList[number]) => r.status === 'not_attending'));
  const manageAttendingGuests = $derived(manageAttendingRsvps.reduce((sum: number, r: typeof rsvpsList[number]) => sum + r.guestCount, 0));
  const manageMaybeGuests = $derived(manageMaybeRsvps.reduce((sum: number, r: typeof rsvpsList[number]) => sum + r.guestCount, 0));

  let locationValue = $state(event.location ?? '');
  let questionType = $state<string>('text');
  let optionsText = $state<string>('');
  let showAddQuestionModal = $state(false);
  let activeTab = $state<'management' | 'rsvps'>('management');
  let playlists = $state<Array<{ id: string; name: string; tracks: { total: number } }>>([]);
  let loadingPlaylists = $state(false);
  let selectedPlaylistId = $state<string>('');
  let deletingQuestionId = $state<string | null>(null);
  let deletingRsvpId = $state<string | null>(null);
  let showDeleteEventConfirm = $state(false);
  
  // Update location value when form values change
  $effect(() => {
    if (eventValues.location !== undefined) {
      locationValue = eventValues.location;
    }
  });

  // Fetch playlists when modal opens and Spotify is connected
  $effect(() => {
    if (showAddQuestionModal && questionType === 'spotify_playlist' && data.hasSpotifyConnected && playlists.length === 0) {
      fetchPlaylists();
    }
  });

  // Ensure playlists are available when editing existing Spotify questions
  $effect(() => {
    if (!data.hasSpotifyConnected || playlists.length > 0) return;
    if (questions.some((question) => question.type === 'spotify_playlist')) {
      fetchPlaylists();
    }
  });

  async function fetchPlaylists() {
    if (loadingPlaylists) {
      return;
    }
    loadingPlaylists = true;
    try {
      const response = await fetch('/api/spotify/playlists');
      if (response.ok) {
        const data = await response.json();
        playlists = data.playlists;
      }
    } catch (error) {
      console.error('Failed to fetch playlists:', error);
    } finally {
      loadingPlaylists = false;
    }
  }

  interface ParsedSpotifyTrack {
    id: string;
    name: string;
    artists: string;
    album: string | null;
    image: string | null;
    spotifyUrl: string | null;
  }

  function parseSpotifyTracks(value: string | null | undefined): ParsedSpotifyTrack[] {
    if (!value) {
      return [];
    }

    try {
      const raw = JSON.parse(value);
      const list = Array.isArray(raw) ? raw : [raw];

      return list
        .map((track) => {
          if (!track || typeof track !== 'object') {
            return null;
          }

          const name = typeof track.name === 'string' ? track.name : 'Unknown track';
          const rawArtists = Array.isArray(track.artists)
            ? track.artists
                .map((artist) =>
                  artist && typeof artist === 'object' && typeof artist.name === 'string' ? artist.name : null
                )
                .filter((artist): artist is string => Boolean(artist))
            : [];
          const album =
            track.album && typeof track.album === 'object' && typeof track.album.name === 'string'
              ? track.album.name
              : null;
          const images =
            track.album && typeof track.album === 'object' && Array.isArray(track.album.images)
              ? track.album.images
              : [];
          const image =
            images?.[1]?.url ??
            images?.[0]?.url ??
            images?.[images.length - 1]?.url ??
            null;
          const spotifyUrl =
            track.external_urls && typeof track.external_urls === 'object' && typeof track.external_urls.spotify === 'string'
              ? track.external_urls.spotify
              : null;
          const id =
            (typeof track.id === 'string' && track.id) ||
            (typeof track.uri === 'string' && track.uri) ||
            `${name}:${rawArtists.join(',')}`;

          return {
            id,
            name,
            artists: rawArtists.join(', ') || 'Unknown artist',
            album,
            image,
            spotifyUrl
          } satisfies ParsedSpotifyTrack;
        })
        .filter((track): track is ParsedSpotifyTrack => Boolean(track));
    } catch (error) {
      console.warn('Failed to parse Spotify response value', error);
      return [];
    }
  }

  const toLocalInput = (value: string | Date, timezone: string) => {
    return formatDateTimeForInput(value, timezone);
  };
</script>

<header class="flex justify-between gap-8 items-start mb-10">
  <div>
    <h1 class="text-3xl font-bold text-dark-800 mb-2">{event.title}</h1>
    <p class="text-gray-600 text-sm">{formatDate(event.date, event.timezone)}</p>
  </div>
</header>

{#if isNewlyCreated}
  <div class="bg-gradient-to-br from-primary-500 to-primary-600 text-white rounded-2xl p-8 mb-6 shadow-2xl">
    <h2 class="text-2xl font-bold mb-3">🎉 Event created successfully!</h2>
    <p class="mb-6 text-primary-50">Your event is live! Share the public link with your guests, and you can always return to this page using the management link.</p>
    <div class="bg-white/10 backdrop-blur-sm rounded-xl p-6 space-y-4 mb-6">
      <div>
        <strong class="block mb-2 text-primary-50">Public link (share this):</strong>
        <code class="block bg-white/20 px-4 py-3 rounded-lg text-sm font-mono">{$page.url.origin}/event/{event.publicCode}</code>
      </div>
      <div>
        <strong class="block mb-2 text-primary-50">Management link (keep this private):</strong>
        <code class="block bg-white/20 px-4 py-3 rounded-lg text-sm font-mono">{$page.url.href.replace('?new', '')}</code>
      </div>
    </div>
    <p class="text-sm text-primary-100">💡 These links are also available in your <a href="/dashboard" class="underline hover:text-white transition-colors">dashboard</a></p>
  </div>
{/if}

{#if successMessage}
  <p class="success-banner">{successMessage}</p>
{/if}

{#if message}
  <p class="error-banner">{message}</p>
{/if}

<div class="flex gap-2 mb-8 border-b-2 border-primary-700/10">
  <button 
    class="tab-btn flex items-center gap-2" 
    class:tab-btn-active={activeTab === 'management'}
    onclick={() => activeTab = 'management'}
  >
    <span>⚙️</span>
    <span>Management</span>
  </button>
  <button 
    class="tab-btn flex items-center gap-2" 
    class:tab-btn-active={activeTab === 'rsvps'}
    onclick={() => activeTab = 'rsvps'}
  >
    <span>✅</span>
    <span>RSVPs</span>
    {#if rsvps.length > 0}
      <span class="badge-primary ml-1">{rsvps.length}</span>
    {/if}
  </button>
</div>

{#if activeTab === 'management'}
<section class="mb-8">
  <div class="card mb-8">
    <h2 class="text-2xl font-bold text-dark-800 mb-6">Edit event</h2>
    <form
      method="POST"
      action="?/updateEvent"
      class="space-y-5"
      use:enhance={() => {
        return async ({ update }) => {
          await update({ reset: false });
        };
      }}
    >
      <label class="form-label">
        <span>Event name *</span>
        <input class="input-field" type="text" name="title" value={event.title} required />
      </label>

      <label class="form-label">
        <span>Event date and time *</span>
        <input class="input-field" type="datetime-local" name="date" value={toLocalInput(event.date, event.timezone)} required />
      </label>

      <label class="form-label">
        <span>End date and time</span>
        <input class="input-field" type="datetime-local" name="endDate" value={event.endDate ? toLocalInput(event.endDate, event.timezone) : ''} />
      </label>

      <label class="form-label">
        <span>Timezone *</span>
        <select class="input-field" name="timezone" required>
          {#each COMMON_TIMEZONES as tz}
            <option value={tz.value} selected={event.timezone === tz.value}>{tz.label}</option>
          {/each}
        </select>
        <small>The timezone for your event. All times will be shown in this timezone.</small>
      </label>

      <label class="form-label">
        <span>Location *</span>
        <input class="input-field" type="text" name="location" value={event.location || ''} required />
      </label>

      <label class="form-label">
        <span>Total capacity (0 for unlimited)</span>
        <input class="input-field" type="number" name="rsvpLimit" value={event.rsvpLimit || 0} min="0" required />
      </label>

      <label class="form-label">
        <span>Description</span>
        <textarea class="input-field" name="description" rows="4" style="white-space: pre-wrap;">{event.description || ''}</textarea>
        <small class="text-sm text-gray-600">Supports Markdown formatting (bold, italic, lists, links, etc.)</small>
      </label>

      <!-- Event Customization -->
      <details class="border-2 rounded-2xl overflow-hidden" style="border-color: rgba(124, 93, 250, 0.15);">
        <summary class="flex items-center gap-2 px-5 py-4 cursor-pointer select-none font-semibold bg-gradient-to-r from-primary-50 to-white hover:from-primary-100 list-none">
          <span class="text-xl">🎨</span>
          <span>Customize appearance</span>
        </summary>
        <div class="p-5 space-y-5 bg-white">
          <label class="form-label">
            <span>Event emoji (appears in title)</span>
            <input class="input-field text-2xl" type="text" name="emoji" value={event.emoji || ''} maxlength="10" placeholder="🎉" />
            <small class="text-sm text-gray-600">Optional emoji to show with your event title</small>
          </label>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label class="form-label">
              <span>Primary color</span>
              <select class="input-field" name="primaryColor">
                <option value="violet" selected={!event.primaryColor || event.primaryColor === 'violet'}>Violet (Default)</option>
                <option value="red" selected={event.primaryColor === 'red'}>Red</option>
                <option value="orange" selected={event.primaryColor === 'orange'}>Orange</option>
                <option value="amber" selected={event.primaryColor === 'amber'}>Amber</option>
                <option value="yellow" selected={event.primaryColor === 'yellow'}>Yellow</option>
                <option value="lime" selected={event.primaryColor === 'lime'}>Lime</option>
                <option value="green" selected={event.primaryColor === 'green'}>Green</option>
                <option value="emerald" selected={event.primaryColor === 'emerald'}>Emerald</option>
                <option value="teal" selected={event.primaryColor === 'teal'}>Teal</option>
                <option value="cyan" selected={event.primaryColor === 'cyan'}>Cyan</option>
                <option value="sky" selected={event.primaryColor === 'sky'}>Sky</option>
                <option value="blue" selected={event.primaryColor === 'blue'}>Blue</option>
                <option value="indigo" selected={event.primaryColor === 'indigo'}>Indigo</option>
                <option value="purple" selected={event.primaryColor === 'purple'}>Purple</option>
                <option value="fuchsia" selected={event.primaryColor === 'fuchsia'}>Fuchsia</option>
                <option value="pink" selected={event.primaryColor === 'pink'}>Pink</option>
                <option value="rose" selected={event.primaryColor === 'rose'}>Rose</option>
              </select>
              <small class="text-sm text-gray-600">Main accent color</small>
            </label>

            <label class="form-label">
              <span>Secondary color</span>
              <select class="input-field" name="secondaryColor">
                <option value="pink" selected={!event.secondaryColor || event.secondaryColor === 'pink'}>Pink (Default)</option>
                <option value="red" selected={event.secondaryColor === 'red'}>Red</option>
                <option value="orange" selected={event.secondaryColor === 'orange'}>Orange</option>
                <option value="amber" selected={event.secondaryColor === 'amber'}>Amber</option>
                <option value="yellow" selected={event.secondaryColor === 'yellow'}>Yellow</option>
                <option value="lime" selected={event.secondaryColor === 'lime'}>Lime</option>
                <option value="green" selected={event.secondaryColor === 'green'}>Green</option>
                <option value="emerald" selected={event.secondaryColor === 'emerald'}>Emerald</option>
                <option value="teal" selected={event.secondaryColor === 'teal'}>Teal</option>
                <option value="cyan" selected={event.secondaryColor === 'cyan'}>Cyan</option>
                <option value="sky" selected={event.secondaryColor === 'sky'}>Sky</option>
                <option value="blue" selected={event.secondaryColor === 'blue'}>Blue</option>
                <option value="indigo" selected={event.secondaryColor === 'indigo'}>Indigo</option>
                <option value="purple" selected={event.secondaryColor === 'purple'}>Purple</option>
                <option value="fuchsia" selected={event.secondaryColor === 'fuchsia'}>Fuchsia</option>
                <option value="violet" selected={event.secondaryColor === 'violet'}>Violet</option>
                <option value="rose" selected={event.secondaryColor === 'rose'}>Rose</option>
              </select>
              <small class="text-sm text-gray-600">Secondary accent color</small>
            </label>
          </div>

          <label class="form-label">
            <span>Background image URL</span>
            <input class="input-field" type="url" name="backgroundImage" value={event.backgroundImage || ''} placeholder="https://example.com/image.jpg" />
            <small class="text-sm text-gray-600">Optional background image for your event page</small>
          </label>
        </div>
      </details>

      <button class="btn-primary" type="submit">Update event</button>
    </form>
  </div>

  <div class="card">
    <div class="flex justify-between items-center mb-6">
      <h2 class="text-2xl font-bold text-dark-800">Questions</h2>
      <button type="button" class="btn-primary" onclick={() => showAddQuestionModal = true}>
        + Add Question
      </button>
    </div>

    {#if questions.length === 0}
      <p class="text-center text-gray-500 py-12">No questions yet. Add your first question to start collecting information from attendees.</p>
    {:else}
      <div class="space-y-4">
        {#each questions as question}
          {#key question.id}
            <article class="bg-white border border-primary-700/10 rounded-xl p-6 shadow-sm">
              <header class="flex justify-between items-start mb-4 pb-4 border-b border-gray-200">
                <div>
                  <div class="flex items-center gap-2 mb-2">
                    <h3 class="text-lg font-bold text-dark-800">{question.label}</h3>
                    <span class="px-2 py-1 text-xs font-semibold rounded-lg capitalize {question.type === 'text' ? 'bg-blue-100 text-blue-700' : question.type === 'multiple_choice' ? 'bg-purple-100 text-purple-700' : question.type === 'checkbox' ? 'bg-green-100 text-green-700' : question.type === 'spotify_playlist' ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'}">
                      {question.type === 'spotify_playlist' ? '🎵 Spotify Song' : question.type.replace('_', ' ')}
                    </span>
                  </div>
                  {#if question.quantity}
                    <p class="text-sm text-gray-600">{question.responseCount} of {question.quantity} slots filled</p>
                  {:else}
                    <p class="text-sm text-gray-600">{question.responseCount} responses</p>
                  {/if}
                  {#if question.type === 'spotify_playlist'}
                    <p class="text-xs text-emerald-700 mt-1">
                      Songs per guest: {question.songsPerUser ?? 'Unlimited'}
                    </p>
                  {/if}
                </div>
                <form
                  method="POST"
                  action="?/deleteQuestion"
                  use:enhance={() => {
                    const questionId = question.id;
                    deletingQuestionId = questionId;
                    return async ({ result }) => {
                      if (result.type === 'success') {
                        // Remove question from local state
                        questions = questions.filter(q => q.id !== questionId);
                      }
                      deletingQuestionId = null;
                    };
                  }}
                >
                  <input type="hidden" name="questionId" value={question.id} />
                  <button 
                    type="submit" 
                    class="btn-secondary"
                    disabled={deletingQuestionId === question.id}
                  >
                    {deletingQuestionId === question.id ? 'Deleting...' : 'Delete'}
                  </button>
                </form>
              </header>

              <form method="POST" action="?/updateQuestion" class="space-y-4" use:enhance={() => {
                return async ({ update }) => {
                  await update({ reset: false });
                };
              }}>
                <input type="hidden" name="questionId" value={question.id} />
                <input type="hidden" name="type" value={question.type} />

                <label class="form-label">
                  <span>Question text</span>
                  <input class="input-field" name="label" required value={question.label} />
                  {#if slotErrors[question.id]?.label}
                    <small class="text-red-600 text-sm">{slotErrors[question.id].label[0]}</small>
                  {/if}
                </label>

                {#if question.type === 'multiple_choice' || question.type === 'checkbox'}
                  <label class="form-label">
                    <span>Options (one per line)</span>
                    <textarea class="input-field" name="options" rows="4">{question.options ? JSON.parse(question.options).join('\n') : ''}</textarea>
                    {#if slotErrors[question.id]?.options}
                      <small class="text-red-600 text-sm">{slotErrors[question.id].options[0]}</small>
                    {/if}
                  </label>
                {/if}

                <label class="form-label">
                  <span>Open slots (optional)</span>
                  <input class="input-field" name="quantity" inputmode="numeric" placeholder="Unlimited" value={question.quantity ?? ''} />
                  <small class="text-sm text-gray-600">How many people can respond to this question</small>
                  {#if slotErrors[question.id]?.quantity}
                    <small class="text-red-600 text-sm">{slotErrors[question.id].quantity[0]}</small>
                  {/if}
                </label>

                <label class="form-label">
                  <span>Description</span>
                  <textarea class="input-field" name="description" rows="3" style="white-space: pre-wrap;">{question.description ?? ''}</textarea>
                  <small class="text-sm text-gray-600">Supports Markdown</small>
                  {#if slotErrors[question.id]?.description}
                    <small class="text-red-600 text-sm">{slotErrors[question.id].description[0]}</small>
                  {/if}
                </label>

                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" name="required" checked={question.required} class="w-5 h-5 rounded border-primary-700/25 text-primary-600 focus:ring-primary-500" />
                  <span class="font-medium text-dark-900">Required question</span>
                </label>

                <label class="flex flex-col gap-2 cursor-pointer">
                  <div class="flex items-center gap-3">
                    <input type="checkbox" name="isPublic" checked={question.isPublic} class="w-5 h-5 rounded border-primary-700/25 text-primary-600 focus:ring-primary-500" />
                    <span class="font-medium text-dark-900">Show responses publicly</span>
                  </div>
                  <small class="text-sm text-gray-600 ml-8">Let attendees see what others answered</small>
                </label>

                {#if question.type === 'spotify_playlist' && data.hasSpotifyConnected}
                  <label class="form-label">
                    <span>Spotify playlist</span>
                    {#if loadingPlaylists}
                      <div class="flex items-center gap-2 text-sm text-gray-600 py-3">
                        <div class="w-4 h-4 border-2 border-primary-600 border-t-transparent rounded-full animate-spin"></div>
                        Loading playlists...
                      </div>
                    {:else if playlists.length > 0}
                      <select class="input-field" name="spotifyPlaylistId">
                        <option value="" selected={!question.spotifyPlaylistId}>Create new playlist</option>
                        {#if question.spotifyPlaylistId && !playlists.some((p) => p.id === question.spotifyPlaylistId)}
                          <option value={question.spotifyPlaylistId} selected>
                            Current playlist (no longer available)
                          </option>
                        {/if}
                        {#each playlists as playlist}
                          <option value={playlist.id} selected={question.spotifyPlaylistId === playlist.id}>
                            {playlist.name} ({playlist.tracks.total} songs)
                          </option>
                        {/each}
                      </select>
                      <small class="text-sm text-gray-600">
                        Select an existing playlist or choose "Create new playlist" to start fresh
                      </small>
                    {:else}
                      <input class="input-field" type="hidden" name="spotifyPlaylistId" value="" />
                      <div class="text-sm text-gray-600 py-2">
                        No playlists found. A new playlist will be created when songs are submitted.
                      </div>
                    {/if}
                  </label>

                  <label class="form-label">
                    <span>Songs per user</span>
                    <input
                      class="input-field"
                      type="number"
                      min="1"
                      max="10"
                      name="songsPerUser"
                      value={question.songsPerUser ?? ''}
                      placeholder="Unlimited"
                    />
                    <small class="text-sm text-gray-600">Leave blank for unlimited songs per guest.</small>
                  </label>
                {/if}
                <button class="btn-primary" type="submit">Update question</button>
              </form>
            </article>
          {/key}
        {/each}
      </div>
    {/if}
  </div>
</section>
{/if}

{#if activeTab === 'rsvps'}
<section class="mb-8">
  <div class="flex items-center justify-between mb-6">
    <h2 class="text-2xl font-bold text-dark-800 flex items-center gap-2">
      <span class="text-3xl">✅</span>
      RSVPs
      <span class="text-lg font-normal text-gray-500">({rsvpsList.length} RSVPs, {manageTotalGuests} total guests)</span>
    </h2>
  </div>

  {#if rsvpsList.length === 0}
    <div class="text-center py-16 px-8 bg-gradient-to-br from-white to-primary-50 rounded-[24px] shadow-xl max-w-[500px] mx-auto border border-primary-700/10">
      <div class="text-6xl mb-4">📋</div>
      <h3 class="text-dark-800 mb-2 font-bold text-xl">No RSVPs yet</h3>
      <p class="text-dark-900/70 leading-relaxed">Share your public link to start collecting responses from guests.</p>
    </div>
  {:else}
    <!-- Summary Stats -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
      <div class="bg-gradient-to-br from-green-50 to-green-100/50 rounded-xl p-5 border border-green-200">
        <div class="flex items-center gap-3">
          <span class="text-3xl">✓</span>
          <div>
            <div class="text-2xl font-bold text-green-700">{manageAttendingRsvps.length}</div>
            <div class="text-sm text-green-700/80 font-medium">Attending{#if manageAttendingGuests > manageAttendingRsvps.length} ({manageAttendingGuests} guests){/if}</div>
          </div>
        </div>
      </div>
      <div class="bg-gradient-to-br from-yellow-50 to-yellow-100/50 rounded-xl p-5 border border-yellow-200">
        <div class="flex items-center gap-3">
          <span class="text-3xl">?</span>
          <div>
            <div class="text-2xl font-bold text-yellow-700">{manageMaybeRsvps.length}</div>
            <div class="text-sm text-yellow-700/80 font-medium">Maybe{#if manageMaybeGuests > manageMaybeRsvps.length} ({manageMaybeGuests} guests){/if}</div>
          </div>
        </div>
      </div>
      <div class="bg-gradient-to-br from-gray-50 to-gray-100/50 rounded-xl p-5 border border-gray-200">
        <div class="flex items-center gap-3">
          <span class="text-3xl">✗</span>
          <div>
            <div class="text-2xl font-bold text-gray-700">{manageNotAttendingRsvps.length}</div>
            <div class="text-sm text-gray-700/80 font-medium">Not Attending</div>
          </div>
        </div>
      </div>
    </div>

    <!-- RSVP Cards -->
    <div class="space-y-4">
      {#each rsvpsList as rsvp}
        <article class="bg-white rounded-xl p-6 shadow-[0_2px_8px_rgba(60,35,110,0.08)] border border-primary-700/5 hover:shadow-[0_4px_12px_rgba(60,35,110,0.12)] transition-all">
          <div class="flex flex-col md:flex-row md:items-start gap-4">
            <!-- Main Info -->
            <div class="flex-1">
              <div class="flex items-start gap-3 mb-3">
                <div class="flex-1">
                  <h3 class="text-xl font-bold text-dark-800 mb-2 flex items-center gap-2">
                    {rsvp.name}{#if rsvp.guestCount > 1} <span class="text-base font-normal text-gray-500">(+{rsvp.guestCount - 1} guest{rsvp.guestCount - 1 === 1 ? '' : 's'})</span>{/if}
                  </h3>
                  <div class="flex flex-wrap gap-3 items-center">
                    {#if rsvp.status === 'attending'}
                      <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-green-500/15 text-green-700">
                        <span>✓</span> Attending
                      </span>
                    {:else if rsvp.status === 'maybe'}
                      <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-yellow-500/15 text-yellow-700">
                        <span>?</span> Maybe
                      </span>
                    {:else if rsvp.status === 'not_attending'}
                      <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-gray-500/15 text-gray-600">
                        <span>✗</span> Not Attending
                      </span>
                    {/if}
                    <span class="text-sm text-gray-500">• {formatShortDate(rsvp.createdAt)}</span>
                  </div>
                </div>
              </div>

              {#if rsvp.email}
                <div class="flex items-center gap-2 text-sm text-dark-700 mb-4">
                  <span class="text-base">✉️</span>
                  <a href="mailto:{rsvp.email}" class="hover:text-primary-700 transition-colors">{rsvp.email}</a>
                </div>
              {/if}

              {#if rsvp.responses && rsvp.responses.length > 0}
                <div class="bg-primary-700/5 rounded-lg p-4 mt-4">
                  <h4 class="text-sm font-bold text-dark-800 mb-3 flex items-center gap-2">
                    <span>💬</span> Question Responses
                  </h4>
                  <div class="space-y-3">
                    {#each rsvp.responses as response}
                      <div>
                        <div class="text-xs font-semibold text-primary-700 uppercase tracking-wider mb-1">{response.questionLabel}</div>
                        {#if response.questionType === 'spotify_playlist'}
                          {@const tracks = parseSpotifyTracks(response.value)}
                          {#if tracks.length > 0}
                            <ul class="space-y-3">
                              {#each tracks as track (track.id)}
                                <li class="flex items-center gap-4 p-3 rounded-xl border border-emerald-200 bg-emerald-50/40">
                                  {#if track.image}
                                    <img
                                      src={track.image}
                                      alt={track.album ? `${track.album} artwork` : `${track.name} artwork`}
                                      class="w-12 h-12 rounded-lg shadow-sm object-cover"
                                      loading="lazy"
                                    />
                                  {/if}
                                  <div class="flex-1 min-w-0">
                                    <p class="text-sm font-semibold text-dark-900 truncate">
                                      {#if track.spotifyUrl}
                                        <a
                                          href={track.spotifyUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          class="hover:underline"
                                        >
                                          {track.name}
                                        </a>
                                      {:else}
                                        {track.name}
                                      {/if}
                                    </p>
                                    <p class="text-xs text-dark-600 truncate">{track.artists}</p>
                                    {#if track.album}
                                      <p class="text-xs text-dark-500 truncate">{track.album}</p>
                                    {/if}
                                  </div>
                                  <span class="text-lg" aria-hidden="true">🎧</span>
                                </li>
                              {/each}
                            </ul>
                          {:else}
                            <div class="text-sm text-dark-600 italic">No songs selected</div>
                          {/if}
                        {:else}
                          <div class="text-sm text-dark-800 font-medium">{response.value}</div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                </div>
              {:else}
                <div class="bg-gray-50 rounded-lg p-3 mt-4">
                  <p class="text-sm text-gray-500 italic flex items-center gap-2">
                    <span>📝</span> No question responses
                  </p>
                </div>
              {/if}
            </div>

            <div class="md:ml-auto">
              <form method="POST" action="?/deleteRsvp" use:enhance={() => {
                const rsvpId = rsvp.id;
                deletingRsvpId = rsvpId;
                return async ({ result }) => {
                  if (result.type === 'success') {
                    // Remove RSVP from local state
                    rsvpsList = rsvpsList.filter(r => r.id !== rsvpId);
                  }
                  deletingRsvpId = null;
                };
              }}>
                <input type="hidden" name="rsvpId" value={rsvp.id} />
                <button 
                  type="submit" 
                  class="px-4 py-2 rounded-lg text-sm font-semibold transition-all bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 hover:border-red-300 disabled:opacity-50"
                  disabled={deletingRsvpId === rsvp.id}
                >
                  {deletingRsvpId === rsvp.id ? '🗑️ Removing...' : '🗑️ Remove'}
                </button>
              </form>
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>
{/if}

<section class="card border-2 border-red-200 bg-red-50/50">
  <h2 class="text-2xl font-bold text-red-700 mb-4">Danger Zone</h2>
  <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
    <div>
      <h3 class="text-lg font-semibold text-dark-800 mb-2">Delete this event</h3>
      <p class="text-sm text-gray-600">This will permanently delete the event, all slots, and all signups. This action cannot be undone.</p>
    </div>
    {#if showDeleteEventConfirm}
      <div class="flex gap-2">
        <form method="POST" action="?/deleteEvent" use:enhance={() => {
          return async ({ update }) => {
            await update();
          };
        }}>
          <button type="submit" class="btn-danger whitespace-nowrap">Yes, Delete</button>
        </form>
        <button type="button" class="btn-secondary whitespace-nowrap" onclick={() => showDeleteEventConfirm = false}>Cancel</button>
      </div>
    {:else}
      <button type="button" class="btn-danger whitespace-nowrap" onclick={() => showDeleteEventConfirm = true}>Delete Event</button>
    {/if}
  </div>
</section>

{#if showAddQuestionModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => showAddQuestionModal = false}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h2>Add a question</h2>
        <button type="button" class="close-btn" onclick={() => showAddQuestionModal = false}>
          ✕
        </button>
      </div>
      
      <form
        method="POST"
        action="?/addQuestion"
        class="space-y-5 px-8 py-6"
        use:enhance={() => {
          return async ({ result, update }) => {
            await update();
            if (result.type === 'success' && result.data) {
              // Add the new question to the local state
              const newQuestion = (result.data as any).question;
              if (newQuestion) {
                questions = [...questions, newQuestion];
              }
              questionType = 'text';
              optionsText = '';
              showAddQuestionModal = false;
            }
          };
        }}
      >
        <label class="form-label">
          <span>Question type</span>
          <select class="input-field" name="type" bind:value={questionType} required>
            <option value="text">Text</option>
            <option value="multiple_choice">Multiple Choice</option>
            <option value="checkbox">Checkbox</option>
            <option value="slots">Slots</option>
            <option value="spotify_playlist">Spotify Playlist Song</option>
          </select>
        </label>

        {#if questionType === 'spotify_playlist' && !data.hasSpotifyConnected}
          <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p class="text-sm text-yellow-800">
              <strong>⚠️ Spotify not connected</strong><br />
              You need to <a href="/settings" class="underline font-semibold">connect your Spotify account</a> before adding a Spotify playlist question.
            </p>
          </div>
        {/if}

        <label class="form-label">
          <span>Question label *</span>
          <input class="input-field" type="text" name="label" required />
        </label>

        {#if questionType === 'multiple_choice' || questionType === 'checkbox' || questionType === 'slots'}
          <label class="form-label">
            <span>Options (one per line) *</span>
            <textarea class="input-field" name="options" bind:value={optionsText} rows="4" required></textarea>
            <small class="text-sm text-gray-600">Enter each option on a new line</small>
          </label>
        {/if}

        {#if questionType !== 'spotify_playlist'}
        <label class="form-label">
          <span>Open slots</span>
          <input class="input-field" type="number" name="quantity" min="0" value="0" />
          <small class="text-sm text-gray-600">0 for unlimited</small>
        </label>
        {/if}

        {#if questionType === 'spotify_playlist' && data.hasSpotifyConnected}
          <label class="form-label">
            <span>Select Playlist</span>
            {#if loadingPlaylists}
              <div class="flex items-center gap-2 text-sm text-gray-600 py-3">
                <div class="w-4 h-4 border-2 border-primary-600 border-t-transparent rounded-full animate-spin"></div>
                Loading playlists...
              </div>
            {:else if playlists.length > 0}
              <select class="input-field" name="spotifyPlaylistId" bind:value={selectedPlaylistId}>
                <option value="">Create new playlist</option>
                {#each playlists as playlist}
                  <option value={playlist.id}>{playlist.name} ({playlist.tracks.total} songs)</option>
                {/each}
              </select>
              <small class="text-sm text-gray-600">
                Select an existing playlist or leave blank to create a new one when songs are submitted
              </small>
            {:else}
              <input class="input-field" type="hidden" name="spotifyPlaylistId" value="" />
              <div class="text-sm text-gray-600 py-2">
                No playlists found. A new playlist will be created when songs are submitted.
              </div>
            {/if}
          </label>

          <label class="form-label">
            <span>Songs per user</span>
            <input
              class="input-field"
              type="number"
              name="songsPerUser"
              min="1"
              max="10"
              value={addSlotValues.songsPerUser ?? '1'}
              placeholder="Unlimited"
            />
            <small class="text-sm text-gray-600">
              Leave blank for unlimited, or enter a number to cap songs each guest can add.
            </small>
          </label>
        {/if}

        <label class="form-label">
          <span>Description</span>
          <textarea class="input-field" name="description" rows="3" style="white-space: pre-wrap;"></textarea>
          <small class="text-sm text-gray-600">Supports Markdown</small>
        </label>

        <label class="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" name="required" class="w-5 h-5 rounded border-primary-700/25 text-primary-600 focus:ring-primary-500" />
          <span class="font-medium text-dark-900">Required question</span>
        </label>

        <label class="flex flex-col gap-2 cursor-pointer">
          <div class="flex items-center gap-3">
            <input type="checkbox" name="isPublic" class="w-5 h-5 rounded border-primary-700/25 text-primary-600 focus:ring-primary-500" />
            <span class="font-medium text-dark-900">Show responses publicly</span>
          </div>
          <small class="text-sm text-gray-600 ml-8">When enabled, all attendees can see everyone's responses to this question</small>
        </label>

        <button class="btn-primary w-full" type="submit">Add question</button>
      </form>
    </div>
  </div>
{/if}
