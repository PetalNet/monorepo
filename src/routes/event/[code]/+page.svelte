<script lang="ts">
  import { formatDate, formatShortDate } from '$lib/utils/format';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { enhance } from '$app/forms';
  import type { ActionData, PageData } from './$types';
  import { onMount, tick } from 'svelte';
  import { loadGoogleMaps } from '$lib/utils/googleMaps';
  import { env } from '$env/dynamic/public';
  import SpotifySongSelector from '$lib/components/SpotifySongSelector.svelte';

  const { data, form } = $props<{ data: PageData; form: ActionData | null }>();
  const event = data.event;
  const isOwner = data.isOwner;
  
  // Color mapping from Tailwind
  const colorMap: Record<string, {50: string, 100: string, 600: string, 700: string, 800: string, 900: string}> = {
    red: {50: '#fef2f2', 100: '#fee2e2', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d'},
    orange: {50: '#fff7ed', 100: '#ffedd5', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12'},
    amber: {50: '#fffbeb', 100: '#fef3c7', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f'},
    yellow: {50: '#fefce8', 100: '#fef9c3', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12'},
    lime: {50: '#f7fee7', 100: '#ecfccb', 600: '#65a30d', 700: '#4d7c0f', 800: '#3f6212', 900: '#365314'},
    green: {50: '#f0fdf4', 100: '#dcfce7', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d'},
    emerald: {50: '#ecfdf5', 100: '#d1fae5', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b'},
    teal: {50: '#f0fdfa', 100: '#ccfbf1', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a'},
    cyan: {50: '#ecfeff', 100: '#cffafe', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63'},
    sky: {50: '#f0f9ff', 100: '#e0f2fe', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e'},
    blue: {50: '#eff6ff', 100: '#dbeafe', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a'},
    indigo: {50: '#eef2ff', 100: '#e0e7ff', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81'},
    violet: {50: '#f5f3ff', 100: '#ede9fe', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95'},
    purple: {50: '#faf5ff', 100: '#f3e8ff', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87'},
    fuchsia: {50: '#fdf4ff', 100: '#fae8ff', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75'},
    pink: {50: '#fdf2f8', 100: '#fce7f3', 600: '#db2777', 700: '#be185d', 800: '#9f1239', 900: '#831843'},
    rose: {50: '#fff1f2', 100: '#ffe4e6', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337'},
  };
  
  // Legacy hex to color name mapping (for old events)
  const hexToColorName: Record<string, string> = {
    '#EF4444': 'red',
    '#F97316': 'orange',
    '#F59E0B': 'amber',
    '#EAB308': 'yellow',
    '#84CC16': 'lime',
    '#22C55E': 'green',
    '#10B981': 'emerald',
    '#14B8A6': 'teal',
    '#06B6D4': 'cyan',
    '#0EA5E9': 'sky',
    '#3B82F6': 'blue',
    '#6366F1': 'indigo',
    '#8B5CF6': 'violet',
    '#A855F7': 'purple',
    '#D946EF': 'fuchsia',
    '#EC4899': 'pink',
    '#F43F5E': 'rose',
  };
  
  // Color utilities - handle both old hex values and new color names
  const getPrimaryColor = () => {
    if (!event.primaryColor) return 'violet';
    // Check if it's a hex color (old format)
    if (event.primaryColor.startsWith('#')) {
      return hexToColorName[event.primaryColor] || 'violet';
    }
    return event.primaryColor;
  };
  
  const getSecondaryColor = () => {
    if (!event.secondaryColor) return 'pink';
    // Check if it's a hex color (old format)
    if (event.secondaryColor.startsWith('#')) {
      return hexToColorName[event.secondaryColor] || 'pink';
    }
    return event.secondaryColor;
  };
  
  const primaryColor = getPrimaryColor();
  const secondaryColor = getSecondaryColor();
  const primaryColors = colorMap[primaryColor] || colorMap.violet;
  const secondaryColors = colorMap[secondaryColor] || colorMap.pink;

  const hexToRgb = (value: string | null | undefined) => {
    if (!value) {
      return { r: 255, g: 255, b: 255 };
    }

    const normalized = String(value).trim();
    const rgbMatch = normalized.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (rgbMatch) {
      return {
        r: Number(rgbMatch[1]),
        g: Number(rgbMatch[2]),
        b: Number(rgbMatch[3])
      };
    }

    const trimmed = normalized.replace('#', '');
    if (!/^[0-9a-fA-F]{3,8}$/.test(trimmed)) {
      return { r: 255, g: 255, b: 255 };
    }
    const expanded =
      trimmed.length === 3 || trimmed.length === 4
        ? trimmed
            .split('')
            .map((c) => c + c)
            .join('')
        : trimmed.length >= 6
          ? trimmed.slice(0, 6)
          : trimmed.padEnd(6, trimmed[trimmed.length - 1] ?? '0');
    return {
      r: parseInt(expanded.slice(0, 2), 16),
      g: parseInt(expanded.slice(2, 4), 16),
      b: parseInt(expanded.slice(4, 6), 16)
    };
  };

  const withAlpha = (color: string | null | undefined, alpha: number) => {
    const { r, g, b } = hexToRgb(color);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const mixColors = (colorA: string, colorB: string, weight = 0.5, alpha = 1) => {
    const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max);
    const w = clamp(weight);
    const a = hexToRgb(colorA);
    const b = hexToRgb(colorB);
    const r = Math.round(a.r * w + b.r * (1 - w));
    const g = Math.round(a.g * w + b.g * (1 - w));
    const bl = Math.round(a.b * w + b.b * (1 - w));
    const aFixed = Number(alpha.toFixed(3));
    if (aFixed >= 1) {
      return `rgb(${r}, ${g}, ${bl})`;
    }
    return `rgba(${r}, ${g}, ${bl}, ${aFixed})`;
  };

const lighten = (color: string, amount = 0.2, alpha = 1) =>
  mixColors(color, '#ffffff', 1 - amount, alpha);
const darken = (color: string, amount = 0.2, alpha = 1) =>
  mixColors(color, '#000000', 1 - amount, alpha);

const pageBackgroundLight = mixColors('#fdfbff', mixColors(primaryColors[50], secondaryColors[50], 0.55, 1), 0.82, 1);
const darkCanvasBase = '#0c0b11'; // Deep neutral black base
const pageBackgroundDark = '#0c0b11'; // Solid base for dark mode

const backgroundImage = event.backgroundImage ? `url("${event.backgroundImage}")` : 'none';
const backgroundOverlayLight = event.backgroundImage
  ? `linear-gradient(to bottom, ${withAlpha('#ffffff', 0.92)}, ${withAlpha('#ffffff', 0.96)})`
  : `radial-gradient(120% 120% at 20% -12%, ${withAlpha(primaryColors[100], 0.32)}, transparent 62%), radial-gradient(140% 140% at 92% 120%, ${withAlpha(secondaryColors[100], 0.18)}, transparent 70%)`;
const backgroundOverlayDark = event.backgroundImage
  ? `linear-gradient(to bottom, rgba(0,0,0,0.85), rgba(0,0,0,0.9))`
  : `linear-gradient(135deg, ${mixColors('#0c0b11', primaryColors[900], 0.85, 1)} 0%, ${mixColors('#0c0b11', secondaryColors[900], 0.88, 1)} 100%), radial-gradient(120% 120% at 18% -14%, ${withAlpha(primaryColors[600], 0.18)}, transparent 58%), radial-gradient(140% 150% at 92% 125%, ${withAlpha(secondaryColors[600], 0.15)}, transparent 68%)`;

  const themeVars = {
    '--event-primary-50': primaryColors[50],
    '--event-primary-100': primaryColors[100],
    '--event-primary-600': primaryColors[600],
    '--event-primary-700': primaryColors[700],
    '--event-primary-800': primaryColors[800],
    '--event-primary-900': primaryColors[900],
    '--event-primary-600-alpha': `${primaryColors[600]}30`,
    '--event-secondary-50': secondaryColors[50],
    '--event-secondary-100': secondaryColors[100],
    '--event-secondary-600': secondaryColors[600],
    '--event-secondary-700': secondaryColors[700],
    '--event-secondary-800': secondaryColors[800],
    '--event-secondary-900': secondaryColors[900],
    '--event-secondary-600-alpha': withAlpha(secondaryColors[600], 0.28),
    '--event-page-background': pageBackgroundLight,
    '--event-page-background-dark': pageBackgroundDark,
    '--event-background-image': backgroundImage,
    '--event-background-overlay': backgroundOverlayLight,
    '--event-background-overlay-dark': backgroundOverlayDark,
'--event-background-attachment': event.backgroundImage ? 'fixed' : 'scroll',
'--event-card-surface': '#ffffff',
'--event-card-surface-dark': 'rgba(28, 28, 35, 0.85)',
'--event-section-surface': '#ffffff',
'--event-section-surface-dark': 'rgba(20, 20, 28, 0.8)',
'--event-surface-border': withAlpha(primaryColors[600], 0.1),
'--event-surface-border-dark': 'rgba(255, 255, 255, 0.08)',
'--event-surface-glow-dark': withAlpha(primaryColors[600], 0.15),
'--event-panel-surface': '#ffffff',
'--event-panel-surface-dark': 'rgba(25, 25, 32, 0.85)',
'--event-panel-shadow': withAlpha(primaryColors[600], 0.16),
'--event-panel-shadow-dark': '0 8px 30px rgba(0, 0, 0, 0.6)',
'--event-entry-surface-dark': 'rgba(20, 20, 28, 0.9)',
'--event-header-bg-light': mixColors(primaryColors[100], secondaryColors[100], 0.55, 0.9),
'--event-header-bg-dark': `linear-gradient(135deg, rgba(${hexToRgb(primaryColors[700]).r}, ${hexToRgb(primaryColors[700]).g}, ${hexToRgb(primaryColors[700]).b}, 0.2), rgba(${hexToRgb(secondaryColors[700]).r}, ${hexToRgb(secondaryColors[700]).g}, ${hexToRgb(secondaryColors[700]).b}, 0.15))`,
'--event-header-border-light': withAlpha(secondaryColors[600], 0.32),
'--event-header-border-dark': 'rgba(255, 255, 255, 0.1)',
'--event-header-text-light': mixColors(primaryColors[900], secondaryColors[900], 0.6, 0.95),
'--event-header-text-dark': '#ffffff',
'--event-topbar-chip-bg': mixColors(primaryColors[50], secondaryColors[50], 0.4, 0.78),
'--event-topbar-chip-bg-dark': `rgba(${hexToRgb(primaryColors[600]).r}, ${hexToRgb(primaryColors[600]).g}, ${hexToRgb(primaryColors[600]).b}, 0.25)`,
'--event-topbar-chip-border': withAlpha(secondaryColors[600], 0.48),
'--event-topbar-chip-text': mixColors(primaryColors[900], secondaryColors[900], 0.5, 0.95),
'--event-topbar-chip-text-dark': '#ffffff',
    '--event-summary-attending-bg': mixColors(primaryColors[100], secondaryColors[50], 0.56, 0.92),
    '--event-summary-attending-bg-dark': `rgba(${hexToRgb(primaryColors[600]).r}, ${hexToRgb(primaryColors[600]).g}, ${hexToRgb(primaryColors[600]).b}, 0.25)`,
    '--event-summary-attending-text': primaryColors[800],
    '--event-summary-attending-text-dark': '#ffffff',
    '--event-summary-attending-border': withAlpha(primaryColors[600], 0.18),
    '--event-summary-attending-border-dark': `rgba(${hexToRgb(primaryColors[600]).r}, ${hexToRgb(primaryColors[600]).g}, ${hexToRgb(primaryColors[600]).b}, 0.3)`,
    '--event-summary-maybe-bg': mixColors(secondaryColors[100], '#ffffff', 0.53, 0.9),
    '--event-summary-maybe-bg-dark': `rgba(${hexToRgb(secondaryColors[600]).r}, ${hexToRgb(secondaryColors[600]).g}, ${hexToRgb(secondaryColors[600]).b}, 0.25)`,
    '--event-summary-maybe-text': secondaryColors[800],
    '--event-summary-maybe-text-dark': '#ffffff',
    '--event-summary-maybe-border': withAlpha(secondaryColors[600], 0.2),
    '--event-summary-maybe-border-dark': `rgba(${hexToRgb(secondaryColors[600]).r}, ${hexToRgb(secondaryColors[600]).g}, ${hexToRgb(secondaryColors[600]).b}, 0.3)`,
    '--event-summary-not-bg': mixColors(primaryColors[100], '#ffffff', 0.62, 0.9),
    '--event-summary-not-bg-dark': 'rgba(40, 40, 48, 0.6)',
    '--event-summary-not-text': primaryColors[700],
    '--event-summary-not-text-dark': '#c9c9d4',
    '--event-summary-not-border': withAlpha(primaryColors[600], 0.16),
    '--event-summary-not-border-dark': 'rgba(255, 255, 255, 0.1)',
    '--event-entry-chip-bg-dark': `rgba(${hexToRgb(primaryColors[600]).r}, ${hexToRgb(primaryColors[600]).g}, ${hexToRgb(primaryColors[600]).b}, 0.3)`,
    '--event-entry-chip-text-dark': '#ffffff',
    '--event-badge-bg-dark': `rgba(${hexToRgb(secondaryColors[600]).r}, ${hexToRgb(secondaryColors[600]).g}, ${hexToRgb(secondaryColors[600]).b}, 0.3)`,
    '--event-badge-text-dark': '#ffffff',
    '--event-text-primary': '#1b1430',
    '--event-text-secondary': '#362a54',
    '--event-text-muted': '#5f5177',
    '--event-text-primary-dark': '#ffffff',
    '--event-text-secondary-dark': '#c9c9d4',
    '--event-text-muted-dark': '#8b8b99',
    '--event-divider-dark': withAlpha(secondaryColors[600], 0.22)
  } satisfies Record<string, string>;

  const colorStyles = Object.entries(themeVars)
    .map(([key, value]) => `${key}: ${value};`)
    .join('\n');

  // Apply event colors to the document root for layout theming
  $effect(() => {
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      for (const [key, value] of Object.entries(themeVars)) {
        root.style.setProperty(key, value);
      }
      root.setAttribute('data-event-page', 'true');
      root.setAttribute('data-event-emoji', event.emoji || '');
      root.setAttribute('data-event-title', event.title);
    }
    
    return () => {
      if (typeof document !== 'undefined') {
        const root = document.documentElement;
        root.removeAttribute('data-event-page');
        root.removeAttribute('data-event-emoji');
        root.removeAttribute('data-event-title');
        for (const key of Object.keys(themeVars)) {
          root.style.removeProperty(key);
        }
      }
    };
  });
  
  // Make rsvps reactive so we can update without reload
  let rsvps = $state(data.rsvps);
  let rsvpCount = $state(data.event.rsvpCount);
  let questionResponseCounts = $state<Record<string, number>>(
    Object.fromEntries(event.questions.map((q: any) => [q.id, q.responseCount]))
  );

  const errors = $derived<Record<string, string[]>>((form?.errors ?? {}) as Record<string, string[]>);
  const values = $derived<Record<string, string>>((form?.values ?? {}) as Record<string, string>);
  const message = $derived<string | null>(form?.message ?? null);
  const success = $derived(form?.success ?? false);
  const formType = $derived(form?.type ?? null);

  // Initialize responses with required question IDs
  const requiredQuestionIds = event.questions.filter((q: any) => q.required).map((q: any) => q.id);
  
  let responses = $state<Record<string, string>>({});
  let showRsvpModal = $state(false);
  let showEditModal = $state(false);
  let editingRsvp = $state<any>(null);
  let currentPin = $state<string>('');
  let lastFormType = $state<string | null>(null);
  let editingRsvpId = $state<string>('');
  let pinInput = $state<string>('');
  let pinError = $state<string>('');
  let editingStatus = $state<'attending' | 'maybe' | 'not_attending'>('attending');
  let newRsvpStatus = $state<'attending' | 'maybe' | 'not_attending'>('attending');
  let showCancelConfirm = $state(false);
  
  // Collapsible sections state
  let showAttending = $state(true);
  let showMaybe = $state(true);
  let showNotAttending = $state(false);
  
  // Map state
  let mapElement = $state<HTMLDivElement>();
  let map: google.maps.Map | null = null;
  let marker: google.maps.marker.AdvancedMarkerElement | null = null;

  // Prevent body scroll when modals are open
  $effect(() => {
    if (typeof document !== 'undefined') {
      if (showRsvpModal || showEditModal || editingRsvpId) {
        document.body.classList.add('no-scroll');
      } else {
        document.body.classList.remove('no-scroll');
      }
    }
  });

  let mapLoadRequested = false;

  const requestMapLoad = async () => {
    if (mapLoadRequested) return;
    mapLoadRequested = true;

    const apiKey = env.PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!event.location || !apiKey || apiKey === 'your-google-maps-api-key') {
      return;
    }

    try {
      await loadGoogleMaps(apiKey);
      await initializeMap();
    } catch (err) {
      console.error('Failed to load map:', err);
    }
  };

  // Lazily initialize the map when it comes into view
  onMount(() => {
    if (!event.location) return;

    let observer: IntersectionObserver | null = null;

    const setupObserver = async () => {
      await tick();

      if (typeof window === 'undefined' || !mapElement) {
        requestMapLoad();
        return;
      }

      if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(
          (entries) => {
            const isVisible = entries.some((entry) => entry.isIntersecting);
            if (isVisible) {
              observer?.disconnect();
              // Performance: Delay map loading slightly to prioritize LCP
              if ('requestIdleCallback' in window) {
                requestIdleCallback(() => requestMapLoad(), { timeout: 1000 });
              } else {
                setTimeout(() => requestMapLoad(), 200);
              }
            }
          },
          { rootMargin: '200px 0px' }
        );

        observer.observe(mapElement);
      } else {
        requestMapLoad();
      }
    };

    setupObserver();

    return () => observer?.disconnect();
  });

  async function initializeMap() {
    if (!event.location || !mapElement) return;

    try {
      // Geocode the address
      const geocoder = new google.maps.Geocoder();
      const result = await geocoder.geocode({ address: event.location });

      if (result.results[0]) {
        const location = result.results[0].geometry.location;

        const { Map } = await google.maps.importLibrary("maps") as google.maps.MapsLibrary;
        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker") as google.maps.MarkerLibrary;

        map = new Map(mapElement, {
          center: location,
          zoom: 15,
          mapId: 'EVENT_MAP_ID',
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          zoomControl: true,
        });

        marker = new AdvancedMarkerElement({
          map: map,
          position: location,
        });
      }
    } catch (err) {
      console.error('Failed to geocode address:', err);
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

  type RsvpStatus = 'attending' | 'maybe' | 'not_attending';

  interface PlaylistEntry {
    key: string;
    track: ParsedSpotifyTrack;
    contributor: string;
  }

  function buildPlaylistEntries(
    responses: Array<{ name: string; status: string; value: string }>,
    status: RsvpStatus
  ): PlaylistEntry[] {
    if (!responses || responses.length === 0) {
      return [];
    }

    return responses
      .filter((response) => response.status === status)
      .flatMap((response, responseIndex) => {
        const guestName = response.name ?? 'Guest';
        const tracks = parseSpotifyTracks(response.value);

        return tracks.map((track, trackIndex) => ({
          key: `${status}-${guestName}-${track.id}-${responseIndex}-${trackIndex}`,
          track,
          contributor: guestName
        }));
      });
  }

  function handleOverlayKeydown(event: KeyboardEvent, action: () => void) {
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
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
                .map((artist: any) =>
                  artist && typeof artist === 'object' && typeof artist.name === 'string' ? artist.name : null
                )
                .filter((artist: any): artist is string => Boolean(artist))
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

  // Track form changes and update state accordingly
  $effect(() => {
    const currentFormType = form?.type ?? null;
    
    // Only process if form type changed
    if (currentFormType === lastFormType) return;
    lastFormType = currentFormType;

    // Handle lookup success
    if (form?.type === 'lookupRsvp' && form.success && form.rsvp) {
      editingRsvp = form.rsvp;
      responses = form.rsvp.responses || {};
      editingStatus = form.rsvp.status || 'attending';
      showEditModal = true;
      pinInput = '';
      pinError = '';
      editingRsvpId = '';
    }

    // Handle lookup failure
    if (form?.type === 'lookupRsvp' && !form.success && message) {
      pinError = message;
    }

    // Handle successful update/cancel
    if ((form?.type === 'updateRsvp' || form?.type === 'cancelRsvp') && form.success) {
      editingRsvp = null;
      showEditModal = false;
      currentPin = '';
      responses = {};
      editingStatus = 'attending';
      editingRsvpId = '';
      pinInput = '';
      pinError = '';
    }

    // Handle successful new RSVP
    if (form?.type === 'rsvp' && form.success) {
      showRsvpModal = false;
      newRsvpStatus = 'attending';
      responses = {};
    }
  });

  const rsvpAtLimit = $derived(event.rsvpLimit !== null && rsvpCount >= event.rsvpLimit);

  function openRsvpModal() {
    showRsvpModal = true;
    responses = {};
    newRsvpStatus = 'attending';
  }

  function closeRsvpModal() {
    showRsvpModal = false;
    responses = {};
    newRsvpStatus = 'attending';
  }

  function closeEditModal() {
    editingRsvp = null;
    showEditModal = false;
    currentPin = '';
    responses = {};
    editingStatus = 'attending';
    editingRsvpId = '';
    pinInput = '';
    pinError = '';
  }

  function promptForPin(rsvpId: string) {
    editingRsvpId = rsvpId;
    pinInput = '';
    pinError = '';
  }

  async function submitPinLookup(e: Event) {
    e.preventDefault();
    if (!pinInput || !editingRsvpId) return;

    const formData = new FormData();
    formData.append('rsvpId', editingRsvpId);
    formData.append('pin', pinInput);

    const response = await fetch('?/lookupRsvp', {
      method: 'POST',
      body: formData
    });

    // Let the form action handle the response
    if (response.ok) {
      // The page will reload with the form data
      window.location.reload();
    }
  }
</script>

<svelte:head>
  <title>{event.title} - PetalBoard</title>
</svelte:head>

<style>
  .event-page-wrapper {
    background-color: var(--event-page-background, #f7f5ff);
    background-image: var(--event-background-overlay, none), var(--event-background-image, none);
    background-repeat: no-repeat;
    background-size: cover;
    background-position: center;
    background-attachment: var(--event-background-attachment, scroll);
    min-height: 100vh;
  }
  
  :global(.dark) .event-page-wrapper {
    background-color: var(--event-page-background-dark, #141228);
    background-image: var(--event-background-overlay-dark, none), var(--event-background-image, none);
  }
  
  .event-card {
    background: var(--event-card-surface, rgba(255, 255, 255, 0.95));
    box-shadow: 0 4px 24px -4px rgba(0, 0, 0, 0.08);
    border: 1px solid var(--event-surface-border, rgba(124, 93, 250, 0.1));
    border-radius: 24px;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
    /* Performance: Contain layout and paint to prevent style recalculation propagation */
    contain: layout paint;
    /* Performance: Hint browser about potential transforms */
    will-change: transform;
  }

  .event-section {
    background: var(--event-section-surface, rgba(255, 255, 255, 0.88));
    border: 1px solid var(--event-surface-border, rgba(124, 93, 250, 0.1));
    border-radius: 18px;
  }

  .event-page-wrapper,
  .event-card,
  .event-section,
  .panel-block,
  .panel-block-body {
    color: var(--event-text-primary, #201437);
  }

  .event-card p,
  .event-card span,
  .event-card small,
  .event-section span,
  .panel-block-body p,
  .panel-block-body span,
  .panel-list-item p,
  .panel-list-item span {
    color: var(--event-text-secondary, #3c2f68);
  }

  .event-card small,
  .event-card .text-dark-600,
  .event-card .text-dark-500 {
    color: var(--event-text-muted, #655b82);
  }

  .event-card a {
    color: var(--event-text-secondary, #372a55);
  }

  .event-card a:hover {
    color: var(--event-text-primary, #1b1430);
  }

  :global(.dark) .event-card {
    background: var(--event-card-surface-dark, rgba(0, 0, 0, 0.4)) !important;
    backdrop-filter: blur(10px);
    box-shadow: 0 16px 32px -12px rgba(6, 7, 18, 0.55), 0 0 0 1px var(--event-surface-glow-dark, rgba(124, 93, 250, 0.16));
    border-color: var(--event-surface-border-dark, rgba(124, 93, 250, 0.28));
    color: rgba(248, 247, 255, 0.96);
  }

  :global(.dark) .event-section {
    background: var(--event-section-surface-dark, rgba(0, 0, 0, 0.3)) !important;
    border-color: var(--event-surface-border-dark, rgba(124, 93, 250, 0.28));
    color: rgba(240, 239, 252, 0.92);
  }

  :global(.dark) .event-page-wrapper,
  :global(.dark) .event-card,
  :global(.dark) .event-section,
  :global(.dark) .panel-block,
  :global(.dark) .panel-block-body {
    color: var(--event-text-primary-dark, #f4f3ff);
  }

  :global(.dark) .event-card p,
  :global(.dark) .event-card span,
  :global(.dark) .event-card a,
  :global(.dark) .panel-block-body p,
  :global(.dark) .panel-block-body span,
  :global(.dark) .panel-list-item p,
  :global(.dark) .panel-list-item span {
    color: var(--event-text-secondary-dark, #d9d8f5);
  }

  :global(.dark) .event-card small,
  :global(.dark) .panel-list-item .text-dark-600,
  :global(.dark) .panel-list-item .text-dark-500,
  :global(.dark) .event-card .text-dark-600,
  :global(.dark) .event-card .text-dark-500 {
    color: var(--event-text-muted-dark, #bdbbe0) !important;
  }

  :global(.dark) .text-dark-900 {
    color: var(--event-text-primary-dark, #f4f3ff) !important;
  }

  :global(.dark) .text-dark-800,
  :global(.dark) .text-dark-700 {
    color: var(--event-text-secondary-dark, #d9d8f5) !important;
  }

  :global(.dark) .text-dark-600,
  :global(.dark) .text-dark-500 {
    color: var(--event-text-muted-dark, #bdbbe0) !important;
  }

  :global(.dark) .event-card a {
    color: var(--event-text-secondary-dark, #e5e1fb);
  }

  :global(.dark) .event-card a:hover {
    color: var(--event-text-primary-dark, #faf8ff);
  }

  :global(.dark) .event-page-wrapper .border,
  :global(.dark) .event-page-wrapper .border-b {
    border-color: var(--event-divider-dark, rgba(124, 93, 250, 0.28)) !important;
  }

  :global(.dark) .event-card .border,
  :global(.dark) .event-card .border-b {
    border-color: var(--event-divider-dark, rgba(124, 93, 250, 0.24)) !important;
  }

  .event-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 32px -4px rgba(0, 0, 0, 0.12), 0 0 0 1px var(--event-primary-600-alpha);
  }

  :global(.dark) .event-card:hover {
    box-shadow: 0 8px 32px -4px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--event-primary-600-alpha);
  }

  details.panel {
    background: var(--event-panel-surface);
    border: 1px solid var(--event-surface-border);
    border-radius: 20px;
    /* Performance: Contain layout to isolate reflows */
    contain: layout style;
    box-shadow: 0 2px 12px -4px var(--event-panel-shadow);
    overflow: hidden;
    transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  }
  
  /* Performance: Skip rendering for closed details */
  details.panel:not([open]) {
    content-visibility: auto;
    contain-intrinsic-size: 0 80px;
  }

  :global(.dark) details.panel {
    background: var(--event-panel-surface-dark);
    border-color: var(--event-surface-border-dark);
    box-shadow: 0 12px 28px -10px var(--event-panel-shadow-dark);
  }

  details.panel > summary {
    border-bottom: 1px solid transparent;
    transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
  }

  details.tone-attending > summary {
    background: var(--event-summary-attending-bg);
    color: var(--event-summary-attending-text);
    border-bottom-color: var(--event-summary-attending-border);
  }

  :global(.dark) details.tone-attending > summary {
    background: var(--event-summary-attending-bg-dark);
    color: var(--event-summary-attending-text-dark);
    border-bottom-color: var(--event-summary-attending-border-dark);
  }

  details.tone-maybe > summary {
    background: var(--event-summary-maybe-bg);
    color: var(--event-summary-maybe-text);
    border-bottom-color: var(--event-summary-maybe-border);
  }

  :global(.dark) details.tone-maybe > summary {
    background: var(--event-summary-maybe-bg-dark);
    color: var(--event-summary-maybe-text-dark);
    border-bottom-color: var(--event-summary-maybe-border-dark);
  }

  details.tone-not > summary {
    background: var(--event-summary-not-bg);
    color: var(--event-summary-not-text);
    border-bottom-color: var(--event-summary-not-border);
  }

  :global(.dark) details.tone-not > summary {
    background: var(--event-summary-not-bg-dark);
    color: var(--event-summary-not-text-dark);
    border-bottom-color: var(--event-summary-not-border-dark);
  }

  .panel-block {
    background: var(--event-panel-surface);
    border: 1px solid var(--event-surface-border);
    border-radius: 20px;
    box-shadow: 0 2px 12px -4px var(--event-panel-shadow);
    overflow: hidden;
    transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    /* Performance: Contain layout for list items */
    contain: layout style;
  }

  :global(.dark) .panel-block {
    background: var(--event-panel-surface-dark);
    border-color: var(--event-surface-border-dark);
    box-shadow: 0 12px 28px -10px var(--event-panel-shadow-dark);
  }

  .panel-block-header {
    border-bottom: 1px solid transparent;
    transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
  }

  .panel-block-body {
    background: transparent;
  }

  .panel-block.tone-attending .panel-block-header {
    background: var(--event-summary-attending-bg);
    color: var(--event-summary-attending-text);
    border-bottom-color: var(--event-summary-attending-border);
  }

  :global(.dark) .panel-block.tone-attending .panel-block-header {
    background: var(--event-summary-attending-bg-dark);
    color: var(--event-summary-attending-text-dark);
    border-bottom-color: var(--event-summary-attending-border-dark);
  }

  .panel-block.tone-maybe .panel-block-header {
    background: var(--event-summary-maybe-bg);
    color: var(--event-summary-maybe-text);
    border-bottom-color: var(--event-summary-maybe-border);
  }

  :global(.dark) .panel-block.tone-maybe .panel-block-header {
    background: var(--event-summary-maybe-bg-dark);
    color: var(--event-summary-maybe-text-dark);
    border-bottom-color: var(--event-summary-maybe-border-dark);
  }

  .panel-block.tone-not .panel-block-header {
    background: var(--event-summary-not-bg);
    color: var(--event-summary-not-text);
    border-bottom-color: var(--event-summary-not-border);
  }

  :global(.dark) .panel-block.tone-not .panel-block-header {
    background: var(--event-summary-not-bg-dark);
    color: var(--event-summary-not-text-dark);
    border-bottom-color: var(--event-summary-not-border-dark);
  }

  .panel-body {
    background: transparent;
  }

  .panel-list-item {
    background-color: rgba(255, 255, 255, 0.98);
    border: 1px solid var(--event-surface-border);
    border-radius: 16px;
  }

  :global(.dark) .panel-list-item {
    background-color: var(--event-entry-surface-dark);
    border-color: var(--event-surface-border-dark);
    color: rgba(242, 241, 255, 0.96);
  }

  :global(.dark) .panel-list-item .contributor-chip {
    background-color: var(--event-entry-chip-bg-dark) !important;
    color: var(--event-entry-chip-text-dark) !important;
  }

  :global(.dark) .panel-list-item .text-dark-600 {
    color: rgba(198, 197, 226, 0.72);
  }

  :global(.dark) .panel-list-item button {
    color: var(--event-text-muted-dark, #bdbbe0);
  }

  :global(.dark) .panel-list-item button:hover {
    color: var(--event-text-primary-dark, #f4f3ff);
  }

  :global(.dark) .panel-list-item .text-dark-900 {
    color: var(--event-text-primary-dark, #f4f3ff) !important;
  }

  :global(.dark) .badge-status[data-tone="theme"] {
    background-color: var(--event-badge-bg-dark) !important;
    color: var(--event-badge-text-dark) !important;
    border-color: var(--event-surface-border-dark) !important;
  }

  /* Mobile-specific improvements */
  @media (max-width: 640px) {
    .event-page-wrapper {
      padding-left: 1rem;
      padding-right: 1rem;
      padding-top: 1rem;
      padding-bottom: 1rem;
    }

    .event-card h1 {
      font-size: 1.75rem;
      line-height: 2rem;
    }

    .panel-list-item {
      padding: 0.75rem;
    }

    details.panel > summary,
    .panel-block-header {
      padding-left: 1rem;
      padding-right: 1rem;
      padding-top: 0.875rem;
      padding-bottom: 0.875rem;
      font-size: 1rem;
    }

    .panel-body,
    .panel-block-body {
      padding: 1rem;
    }

    .badge-status {
      font-size: 0.75rem;
      padding: 0.375rem 0.75rem;
    }

    /* Ensure song info is always visible on mobile */
    .panel-list-item .contributor-chip {
      max-width: 100px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Stack song items vertically on very small screens */
    .panel-list-item {
      flex-wrap: wrap;
    }
  }

</style>

<div class="event-page-wrapper max-w-4xl mx-auto px-4 py-8 min-h-screen" style={colorStyles}>
  <!-- Event Header with RSVP Button -->
  <article class="card event-card mb-8">
    <div class="flex flex-col md:flex-row md:justify-between md:items-start gap-6">
      <div class="flex-1">
        <h1 class="text-4xl md:text-4xl font-bold text-dark-900 mb-4">
          {#if event.emoji}
            <span class="mr-2">{event.emoji}</span>
          {/if}
          {event.title}
        </h1>
        <div class="flex flex-col gap-2 mb-4">
          <p class="text-dark-700 m-0 text-sm md:text-base">📅 {formatDate(event.date, event.timezone)}</p>
          {#if event.endDate}
            <p class="text-dark-700 m-0 text-sm md:text-base">⏰ Until {formatShortDate(event.endDate, event.timezone)}</p>
          {/if}
          {#if event.location}
            <div class="flex flex-col gap-3">
              <p class="text-dark-700 m-0 text-sm md:text-base break-words">📍 {event.location}</p>
              {#if env.PUBLIC_GOOGLE_MAPS_API_KEY && env.PUBLIC_GOOGLE_MAPS_API_KEY !== 'your-google-maps-api-key'}
                <div class="w-full h-[200px] rounded-xl overflow-hidden shadow-card" bind:this={mapElement}></div>
              {/if}
            </div>
          {/if}
        </div>
        {#if event.description}
          <div class="my-4 text-dark-800 leading-relaxed text-sm md:text-base prose prose-sm md:prose-base max-w-none">
            {@html renderMarkdown(event.description)}
          </div>
        {/if}
        <div class="flex flex-wrap gap-2 mt-4">
          {#if event.rsvpLimit}
            <span
              class="badge-status"
              data-tone={rsvpAtLimit ? undefined : 'theme'}
              style={rsvpAtLimit
                ? 'background: rgba(254, 226, 226, 0.92); color: #991b1b; border: 1px solid rgba(185, 28, 28, 0.25);'
                : `background-color: ${mixColors(primaryColors[100], secondaryColors[100], 0.55, 0.9)}; color: ${primaryColors[800]}; border: 1px solid ${withAlpha(primaryColors[600], 0.18)};`}
            >
              {rsvpCount} / {event.rsvpLimit} RSVPs
            </span>
          {:else}
            <span
              class="badge-status"
              data-tone="theme"
              style={`background-color: ${mixColors(primaryColors[100], secondaryColors[100], 0.55, 0.9)}; color: ${primaryColors[800]}; border: 1px solid ${withAlpha(primaryColors[600], 0.18)};`}
            >
              {rsvpCount} {rsvpCount === 1 ? 'RSVP' : 'RSVPs'}
            </span>
          {/if}
        </div>
      </div>
      
      {#if !rsvpAtLimit}
        <div class="w-full md:w-auto">
          <button 
            class="rounded-xl w-full md:w-auto px-6 md:px-8 py-3 md:py-4 text-base md:text-lg shadow-button font-semibold transition-colors text-white" 
            style={`background: linear-gradient(135deg, ${primaryColors[600]}, ${secondaryColors[600]}); box-shadow: 0 14px 28px ${withAlpha(primaryColors[600], 0.33)};`}
            onmouseover={(e) => (e.currentTarget.style.background = `linear-gradient(135deg, ${primaryColors[700]}, ${secondaryColors[700]})`)}
            onmouseout={(e) => (e.currentTarget.style.background = `linear-gradient(135deg, ${primaryColors[600]}, ${secondaryColors[600]})`)}
            onfocus={(e) => (e.currentTarget.style.background = `linear-gradient(135deg, ${primaryColors[700]}, ${secondaryColors[700]})`)}
            onblur={(e) => (e.currentTarget.style.background = `linear-gradient(135deg, ${primaryColors[600]}, ${secondaryColors[600]})`)}
            onclick={openRsvpModal}
          >
            RSVP Now
          </button>
        </div>
      {/if}
    </div>
  </article>

  <!-- Success Messages -->
  {#if success && formType === 'rsvp'}
    <div class="success-banner event-card" style={`border-left: 6px solid ${secondaryColors[600]}; background-color: ${mixColors(primaryColors[50], secondaryColors[50], 0.6, 0.78)};`}>
      <h2 class="text-xl font-bold mb-2">✅ You're all set!</h2>
      <p class="mb-0">Your RSVP has been confirmed.</p>
      <div class="rounded-xl p-4 mt-4 event-section" style={`background-color: ${mixColors(primaryColors[100], secondaryColors[50], 0.55, 0.9)}; border: 1px solid ${withAlpha(primaryColors[600], 0.14)};`}>
        <strong style="color: {primaryColors[800]};">Your RSVP ID:</strong> <code class="px-2 py-1 rounded font-semibold" style={`background-color: white; color: ${secondaryColors[700]}; box-shadow: 0 1px 3px ${withAlpha(secondaryColors[600], 0.28)};`}>{form?.rsvpId}</code><br />
        <small>Save this ID and your PIN to manage your RSVP later.</small>
      </div>
    </div>
  {/if}

  {#if success && formType === 'updateRsvp'}
    <div class="success-banner event-card" style={`border-left: 6px solid ${secondaryColors[600]}; background-color: ${mixColors(primaryColors[50], secondaryColors[50], 0.6, 0.78)};`}>
      <h2 class="text-xl font-bold mb-2">✅ Updated!</h2>
      <p class="mb-0">{message}</p>
    </div>
  {/if}

  {#if success && formType === 'cancelRsvp'}
    <div class="card event-card mb-8" style={`border-left: 6px solid ${secondaryColors[600]}; background-color: ${mixColors(primaryColors[50], secondaryColors[50], 0.6, 0.78)};`}>
      <h2 class="text-xl font-bold mb-2">RSVP Cancelled</h2>
      <p class="mb-0">{message}</p>
    </div>
  {/if}

  <!-- WHO'S COMING - Public View -->
  {#if rsvps && rsvps.length > 0}
    {@const attendingList = rsvps.filter((r: any) => r.status === 'attending')}
    {@const maybeList = rsvps.filter((r: any) => r.status === 'maybe')}
    {@const notAttendingList = rsvps.filter((r: any) => r.status === 'not_attending')}
    
    <section class="card event-card mb-8">
      <h2 class="text-xl md:text-2xl font-bold text-dark-900 mb-6">Who's Coming ({attendingList.length} attending, {maybeList.length} maybe)</h2>
      
      <!-- RSVPs List -->
      <div class="flex flex-col gap-4">
        <!-- Attending Section -->
        {#if attendingList.length > 0}
          <details
            class="panel tone-attending overflow-hidden"
            open={showAttending}
            ontoggle={(e) => (showAttending = (e.target as HTMLDetailsElement)?.open ?? false)}
          >
            <summary class="flex justify-between items-center px-4 md:px-6 py-3.5 md:py-4 cursor-pointer select-none font-semibold text-base md:text-lg transition-all list-none hover:opacity-90">
              <span class="flex items-center gap-2">
                <span
                  class="inline-flex items-center justify-center w-6 h-6 rounded-full text-sm"
                  style={`background-color: ${primaryColors[600]}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.28)};`}
                >✓</span>
                Attending ({attendingList.length})
              </span>
              <span class="chevron-icon text-sm opacity-60">▼</span>
            </summary>
            <div class="panel-body grid gap-3 p-4 md:p-6 pt-3 md:pt-4 event-section">
              {#each attendingList as rsvp}
                <div
                  class="panel-list-item border rounded-xl p-3 md:p-4 flex justify-between items-center gap-3 md:gap-4 transition-all hover:shadow-md"
                >
                  <div class="flex flex-col gap-1 min-w-0 flex-1">
                    <strong class="text-dark-900 text-sm md:text-base truncate">{rsvp.name}</strong>
                    {#if rsvp.email && isOwner}
                      <span class="text-dark-700 text-xs md:text-sm truncate">{rsvp.email}</span>
                    {/if}
                    <span class="text-dark-600 text-xs">{formatShortDate(rsvp.createdAt, event.timezone)}</span>
                  </div>
                  <button 
                    class="bg-none border-none cursor-pointer p-2 text-xl opacity-60 hover:opacity-100 transition-opacity flex-shrink-0" 
                    title="Edit {rsvp.name}'s RSVP"
                    onclick={() => promptForPin(rsvp.id)}
                  >
                    ✏️
                  </button>
                </div>
              {/each}
            </div>
          </details>
        {/if}

        <!-- Maybe Section -->
        {#if maybeList.length > 0}
          <details
            class="panel tone-maybe overflow-hidden"
            open={showMaybe}
            ontoggle={(e) => (showMaybe = (e.target as HTMLDetailsElement)?.open ?? false)}
          >
            <summary class="flex justify-between items-center px-4 md:px-6 py-3.5 md:py-4 cursor-pointer select-none font-semibold text-base md:text-lg transition-all list-none hover:opacity-90">
              <span class="flex items-center gap-2">
                <span
                  class="inline-flex items-center justify-center w-6 h-6 rounded-full text-sm"
                  style={`background-color: ${secondaryColors[600]}; color: white; box-shadow: 0 2px 8px ${withAlpha(secondaryColors[600], 0.25)};`}
                >?</span>
                Maybe ({maybeList.length})
              </span>
              <span class="chevron-icon text-sm opacity-60">▼</span>
            </summary>
            <div class="panel-body grid gap-3 p-4 md:p-6 pt-3 md:pt-4 event-section">
              {#each maybeList as rsvp}
                <div
                  class="panel-list-item border rounded-xl p-3 md:p-4 flex justify-between items-center gap-3 md:gap-4 transition-all hover:shadow-md"
                >
                  <div class="flex flex-col gap-1 min-w-0 flex-1">
                    <strong class="text-dark-900 text-sm md:text-base truncate">{rsvp.name}</strong>
                    {#if rsvp.email && isOwner}
                      <span class="text-dark-700 text-xs md:text-sm truncate">{rsvp.email}</span>
                    {/if}
                    <span class="text-dark-600 text-xs">{formatShortDate(rsvp.createdAt, event.timezone)}</span>
                  </div>
                  <button 
                    class="bg-none border-none cursor-pointer p-2 text-xl opacity-60 hover:opacity-100 transition-opacity flex-shrink-0" 
                    title="Edit {rsvp.name}'s RSVP"
                    onclick={() => promptForPin(rsvp.id)}
                  >
                    ✏️
                  </button>
                </div>
              {/each}
            </div>
          </details>
        {/if}

        <!-- Not Attending Section -->
        {#if notAttendingList.length > 0}
          <details
            class="panel tone-not overflow-hidden"
            open={showNotAttending}
            ontoggle={(e) => (showNotAttending = (e.target as HTMLDetailsElement)?.open ?? false)}
          >
            <summary class="flex justify-between items-center px-4 md:px-6 py-3.5 md:py-4 cursor-pointer select-none font-semibold text-base md:text-lg transition-all list-none hover:opacity-80">
              <span class="flex items-center gap-2">
                <span
                  class="inline-flex items-center justify-center w-6 h-6 rounded-full text-sm"
                  style={`background-color: ${withAlpha(primaryColors[600], 0.65)}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.18)};`}
                >✗</span>
                Not Attending ({notAttendingList.length})
              </span>
              <span class="chevron-icon text-sm opacity-60">▼</span>
            </summary>
            <div class="panel-body grid gap-3 p-4 md:p-6 pt-3 md:pt-4 event-section">
              {#each notAttendingList as rsvp}
                <div
                  class="panel-list-item border rounded-xl p-3 md:p-4 flex justify-between items-center gap-3 md:gap-4 transition-all hover:shadow-md"
                >
                  <div class="flex flex-col gap-1 min-w-0 flex-1">
                    <strong class="text-dark-900 text-sm md:text-base truncate">{rsvp.name}</strong>
                    {#if rsvp.email && isOwner}
                      <span class="text-dark-700 text-xs md:text-sm truncate">{rsvp.email}</span>
                    {/if}
                    <span class="text-dark-600 text-xs">{formatShortDate(rsvp.createdAt, event.timezone)}</span>
                  </div>
                  <button 
                    class="bg-none border-none cursor-pointer p-2 text-xl opacity-60 hover:opacity-100 transition-opacity flex-shrink-0" 
                    title="Edit {rsvp.name}'s RSVP"
                    onclick={() => promptForPin(rsvp.id)}
                  >
                    ✏️
                  </button>
                </div>
              {/each}
            </div>
          </details>
        {/if}
      </div>
    </section>
  {/if}

  <!-- Public Question Responses (All Types - In Creation Order) -->
  {#if event.questions.some((q: any) => q.isPublic && q.publicResponses && q.publicResponses.length > 0)}
    {@const publicQuestions = event.questions.filter((q: any) => q.isPublic && q.publicResponses && q.publicResponses.length > 0)}
    {#each publicQuestions as question}
      <section class="card event-card mb-8">
        <div class="flex flex-col md:flex-row md:justify-between md:items-center mb-6 gap-3 md:gap-4 pb-4 border-b" style="border-color: {primaryColors[600]}20;">
          <h2 class="text-xl md:text-2xl font-bold text-dark-900 m-0">{question.label}</h2>
          {#if question.quantity}
            <span class="badge-status" data-tone="theme" style="background-color: {primaryColors[100]}; color: {primaryColors[800]};">
              {question.responseCount} of {question.quantity} slots filled
            </span>
          {:else}
            <span class="badge-status" data-tone="theme" style="background-color: {primaryColors[100]}; color: {primaryColors[800]};">
              {question.responseCount} {question.responseCount === 1 ? 'response' : 'responses'}
            </span>
          {/if}
        </div>
        {#if question.description}
          <div class="m-0 mb-6 text-dark-700 text-sm leading-relaxed prose prose-sm max-w-none">
            {@html renderMarkdown(question.description)}
          </div>
        {/if}
        
        {#if question.type === 'spotify_playlist'}
          <!-- Spotify Playlist Question -->
          <div class="flex flex-col gap-4">
            {#if question.publicResponses.some((r: any) => r.status === 'attending')}
              {@const attendingTrackEntries = buildPlaylistEntries(question.publicResponses ?? [], 'attending')}
            <div class="panel-block tone-attending overflow-hidden">
              <h3
                class="panel-block-header m-0 px-5 py-3.5 text-sm font-semibold flex items-center gap-2.5"
              >
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-sm font-bold" style={`background-color: ${primaryColors[600]}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.28)};`}>✓</span>
                Attending ({attendingTrackEntries.length})
              </h3>
              <div class="panel-block-body px-5 py-4">
                {#if attendingTrackEntries.length > 0}
                  <ul class="space-y-3">
                    {#each attendingTrackEntries as entry, index (entry.key)}
                      <li
                        class="panel-list-item border flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl transition-all hover:shadow-md"
                      >
                        <div class="flex items-center gap-3 sm:gap-4 w-full sm:w-auto">
                          <span class="index-badge w-6 sm:w-8 text-center text-xs sm:text-sm font-bold flex-shrink-0" style="color: {primaryColors[700]};">{index + 1}</span>
                          {#if entry.track.image}
                            <img
                              src={entry.track.image}
                              alt={entry.track.album ? `${entry.track.album} artwork` : `${entry.track.name} artwork`}
                              class="w-12 h-12 sm:w-14 sm:h-14 rounded-lg shadow-sm object-cover flex-shrink-0"
                              loading="lazy"
                            />
                          {/if}
                          <div class="flex-1 min-w-0 space-y-0.5">
                            <p class="text-sm font-semibold text-dark-900 truncate">
                              {#if entry.track.spotifyUrl}
                                <a href={entry.track.spotifyUrl} target="_blank" rel="noreferrer" class="hover:underline">
                                  {entry.track.name}
                                </a>
                              {:else}
                                {entry.track.name}
                              {/if}
                            </p>
                            <p class="text-xs text-dark-600 truncate">{entry.track.artists}</p>
                            {#if entry.track.album}
                              <p class="text-xs text-dark-500 truncate">{entry.track.album}</p>
                            {/if}
                          </div>
                        </div>
                        <div class="flex items-center gap-2 sm:ml-auto flex-shrink-0">
                          <span class="contributor-chip inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold whitespace-nowrap" style="background-color: {primaryColors[100]}; color: {primaryColors[800]};">
                            <span aria-hidden="true">👤</span>
                            <span class="hidden sm:inline">{entry.contributor}</span>
                            <span class="sm:hidden">{entry.contributor.split(' ')[0]}</span>
                          </span>
                          <span class="text-lg sm:text-xl flex-shrink-0" style="color: {primaryColors[600]};" aria-hidden="true">♪</span>
                        </div>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="text-sm text-gray-500 italic">No songs yet from attendees.</p>
                {/if}
              </div>
            </div>
          {/if}
          
          {#if question.publicResponses.some((r: any) => r.status === 'maybe')}
            {@const maybeTrackEntries = buildPlaylistEntries(question.publicResponses ?? [], 'maybe')}
            <div class="panel-block tone-maybe overflow-hidden">
              <h3 class="panel-block-header m-0 px-5 py-3.5 text-sm font-semibold flex items-center gap-2.5">
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-sm font-bold" style={`background-color: ${secondaryColors[600]}; color: white; box-shadow: 0 2px 8px ${withAlpha(secondaryColors[600], 0.24)};`}>?</span>
                Maybe ({maybeTrackEntries.length})
              </h3>
              <div class="panel-block-body px-5 py-4">
                {#if maybeTrackEntries.length > 0}
                  <ul class="space-y-3">
                    {#each maybeTrackEntries as entry, index (entry.key)}
                      <li class="panel-list-item border flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl transition-all hover:shadow-md">
                        <div class="flex items-center gap-3 sm:gap-4 w-full sm:w-auto">
                          <span class="index-badge w-6 sm:w-8 text-center text-xs sm:text-sm font-bold flex-shrink-0" style="color: {primaryColors[700]};">{index + 1}</span>
                          {#if entry.track.image}
                            <img
                              src={entry.track.image}
                              alt={entry.track.album ? `${entry.track.album} artwork` : `${entry.track.name} artwork`}
                              class="w-12 h-12 sm:w-14 sm:h-14 rounded-lg shadow-sm object-cover flex-shrink-0"
                              loading="lazy"
                            />
                          {/if}
                          <div class="flex-1 min-w-0 space-y-0.5">
                            <p class="text-sm font-semibold text-dark-900 truncate">
                              {#if entry.track.spotifyUrl}
                                <a href={entry.track.spotifyUrl} target="_blank" rel="noreferrer" class="hover:underline">
                                  {entry.track.name}
                                </a>
                              {:else}
                                {entry.track.name}
                              {/if}
                            </p>
                            <p class="text-xs text-dark-600 truncate">{entry.track.artists}</p>
                            {#if entry.track.album}
                              <p class="text-xs text-dark-500 truncate">{entry.track.album}</p>
                            {/if}
                          </div>
                        </div>
                        <div class="flex items-center gap-2 sm:ml-auto flex-shrink-0">
                          <span class="contributor-chip inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold whitespace-nowrap" style="background-color: {primaryColors[100]}; color: {primaryColors[800]};">
                            <span aria-hidden="true">👤</span>
                            <span class="hidden sm:inline">{entry.contributor}</span>
                            <span class="sm:hidden">{entry.contributor.split(' ')[0]}</span>
                          </span>
                          <span class="text-lg sm:text-xl flex-shrink-0" style="color: {primaryColors[600]};" aria-hidden="true">♪</span>
                        </div>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="text-sm text-gray-500 italic">No songs yet from “Maybe” guests.</p>
                {/if}
              </div>
            </div>
          {/if}
          
          {#if question.publicResponses.some((r: any) => r.status === 'not_attending')}
            {@const notTrackEntries = buildPlaylistEntries(question.publicResponses ?? [], 'not_attending')}
            <div class="panel-block tone-not overflow-hidden">
              <h3 class="panel-block-header m-0 px-5 py-3.5 text-sm font-semibold flex items-center gap-2.5">
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-sm font-bold" style={`background-color: ${withAlpha(primaryColors[600], 0.65)}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.18)};`}>✗</span>
                Not Attending ({notTrackEntries.length})
              </h3>
              <div class="panel-block-body px-5 py-4">
                {#if notTrackEntries.length > 0}
                  <ul class="space-y-3">
                    {#each notTrackEntries as entry, index (entry.key)}
                      <li class="panel-list-item border flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl transition-all hover:shadow-md">
                        <div class="flex items-center gap-3 sm:gap-4 w-full sm:w-auto">
                          <span class="index-badge w-6 sm:w-8 text-center text-xs sm:text-sm font-bold flex-shrink-0" style="color: {primaryColors[700]};">{index + 1}</span>
                          {#if entry.track.image}
                            <img
                              src={entry.track.image}
                              alt={entry.track.album ? `${entry.track.album} artwork` : `${entry.track.name} artwork`}
                              class="w-12 h-12 sm:w-14 sm:h-14 rounded-lg shadow-sm object-cover flex-shrink-0"
                              loading="lazy"
                            />
                          {/if}
                          <div class="flex-1 min-w-0 space-y-0.5">
                            <p class="text-sm font-semibold text-dark-900 truncate">
                              {#if entry.track.spotifyUrl}
                                <a href={entry.track.spotifyUrl} target="_blank" rel="noreferrer" class="hover:underline">
                                  {entry.track.name}
                                </a>
                              {:else}
                                {entry.track.name}
                              {/if}
                            </p>
                            <p class="text-xs text-dark-600 truncate">{entry.track.artists}</p>
                            {#if entry.track.album}
                              <p class="text-xs text-dark-500 truncate">{entry.track.album}</p>
                            {/if}
                          </div>
                        </div>
                        <div class="flex items-center gap-2 sm:ml-auto flex-shrink-0">
                          <span class="contributor-chip inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold whitespace-nowrap" style="background-color: {primaryColors[100]}; color: {primaryColors[800]};">
                            <span aria-hidden="true">👤</span>
                            <span class="hidden sm:inline">{entry.contributor}</span>
                            <span class="sm:hidden">{entry.contributor.split(' ')[0]}</span>
                          </span>
                          <span class="text-lg sm:text-xl flex-shrink-0" style="color: {primaryColors[600]};" aria-hidden="true">♪</span>
                        </div>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="text-sm text-gray-500 italic">No songs yet from guests marked “Not Attending”.</p>
                {/if}
              </div>
            </div>
          {/if}
          </div>
        {:else}
          <!-- Non-Spotify Question (Text/Radio/Checkbox) -->
          <div class="flex flex-col gap-4">
            {#if question.publicResponses.some((r: any) => r.status === 'attending')}
              {@const attendingResponses = question.publicResponses.filter((r: any) => r.status === 'attending')}
              <div class="panel-block tone-attending overflow-hidden">
                <h3 class="panel-block-header m-0 px-5 py-3.5 text-sm font-semibold flex items-center gap-2.5">
                  <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-sm font-bold" style={`background-color: ${primaryColors[600]}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.28)};`}>✓</span>
                  Attending ({attendingResponses.length})
                </h3>
                <div class="panel-block-body px-5 py-4">
                  <ul class="space-y-2">
                    {#each attendingResponses as response}
                      <li class="panel-list-item border flex items-start gap-3 p-3 rounded-xl">
                        <div class="flex-1 min-w-0">
                          <p class="text-sm font-semibold text-dark-900 mb-1">{response.name}</p>
                          <p class="text-sm text-dark-700 whitespace-pre-wrap break-words">{response.value}</p>
                        </div>
                      </li>
                    {/each}
                  </ul>
                </div>
              </div>
            {/if}

            {#if question.publicResponses.some((r: any) => r.status === 'maybe')}
              {@const maybeResponses = question.publicResponses.filter((r: any) => r.status === 'maybe')}
              <div class="panel-block tone-maybe overflow-hidden">
                <h3 class="panel-block-header m-0 px-5 py-3.5 text-sm font-semibold flex items-center gap-2.5">
                  <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-sm font-bold" style={`background-color: ${secondaryColors[600]}; color: white; box-shadow: 0 2px 8px ${withAlpha(secondaryColors[600], 0.25)};`}>?</span>
                  Maybe ({maybeResponses.length})
                </h3>
                <div class="panel-block-body px-5 py-4">
                  <ul class="space-y-2">
                    {#each maybeResponses as response}
                      <li class="panel-list-item border flex items-start gap-3 p-3 rounded-xl">
                        <div class="flex-1 min-w-0">
                          <p class="text-sm font-semibold text-dark-900 mb-1">{response.name}</p>
                          <p class="text-sm text-dark-700 whitespace-pre-wrap break-words">{response.value}</p>
                        </div>
                      </li>
                    {/each}
                  </ul>
                </div>
              </div>
            {/if}

            {#if question.publicResponses.some((r: any) => r.status === 'not_attending')}
              {@const notAttendingResponses = question.publicResponses.filter((r: any) => r.status === 'not_attending')}
              <div class="panel-block tone-not overflow-hidden">
                <h3 class="panel-block-header m-0 px-5 py-3.5 text-sm font-semibold flex items-center gap-2.5">
                  <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-sm font-bold" style={`background-color: ${withAlpha(primaryColors[600], 0.65)}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.18)};`}>✗</span>
                  Not Attending ({notAttendingResponses.length})
                </h3>
                <div class="panel-block-body px-5 py-4">
                  <ul class="space-y-2">
                    {#each notAttendingResponses as response}
                      <li class="panel-list-item border flex items-start gap-3 p-3 rounded-xl">
                        <div class="flex-1 min-w-0">
                          <p class="text-sm font-semibold text-dark-900 mb-1">{response.name}</p>
                          <p class="text-sm text-dark-700 whitespace-pre-wrap break-words">{response.value}</p>
                        </div>
                      </li>
                    {/each}
                  </ul>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </section>
    {/each}
  {/if}
</div>

<!-- PIN Prompt Modal -->
{#if editingRsvpId && !editingRsvp}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    aria-label="Close PIN prompt"
    onclick={() => { editingRsvpId = ''; pinInput = ''; pinError = ''; }}
    onkeydown={(event) => handleOverlayKeydown(event, () => { editingRsvpId = ''; pinInput = ''; pinError = ''; })}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-prompt-title"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.key === 'Escape' && event.stopPropagation()}
    >
      <div class="modal-header">
        <h3 id="pin-prompt-title">Enter PIN</h3>
        <button class="close-btn" onclick={() => { editingRsvpId = ''; pinInput = ''; pinError = ''; }}>×</button>
      </div>
      <form method="POST" action="?/lookupRsvp" use:enhance={() => {
        // Store the PIN before submission
        const submittedPin = pinInput;
        return async ({ result, update }) => {
          if (result.type === 'success' && result.data?.success) {
            currentPin = submittedPin;
          }
          await update();
        };
      }}>
        <input type="hidden" name="rsvpId" value={editingRsvpId} />
        {#if pinError}
          <div class="error-banner mb-4">{pinError}</div>
        {/if}
        <label class="form-label">
          <span>Enter your PIN to edit this RSVP</span>
          <input
            class="input-field"
            name="pin"
            type="text"
            inputmode="numeric"
            required
            placeholder="Enter PIN"
            maxlength="6"
            bind:value={pinInput}
          />
        </label>
        <div class="modal-actions">
          <button type="submit" class="btn-primary">Unlock</button>
          <button type="button" class="btn-secondary" onclick={() => { editingRsvpId = ''; pinInput = ''; pinError = ''; }}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Edit RSVP Modal -->
{#if showEditModal && editingRsvp}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    aria-label="Close edit RSVP dialog"
    onclick={closeEditModal}
    onkeydown={(event) => {
      if (event.key === 'Escape') {
        closeEditModal();
      }
    }}
  >
    <div
      class="modal large"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-rsvp-title"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <div class="modal-header">
        <h3 id="edit-rsvp-title">Edit Your RSVP</h3>
        <button class="close-btn" onclick={closeEditModal}>×</button>
      </div>
      
      {#if formType === 'updateRsvp' && message && !success}
        <div class="error-banner">{message}</div>
      {/if}

      <form method="POST" action="?/updateRsvp" class="rsvp-form" use:enhance={() => {
        return async ({ result, update }) => {
          if (result.type === 'success' && result.data?.success) {
            // Update reactive state
            if (result.data.rsvps) {
              rsvps = result.data.rsvps;
            }
            if (result.data.questionResponseCounts) {
              questionResponseCounts = result.data.questionResponseCounts as Record<string, number>;
            }
            // Close modal
            closeEditModal();
          }
          await update();
        };
      }}>
        <input type="hidden" name="rsvpId" value={editingRsvp.id} />
        <input type="hidden" name="pin" value={currentPin} />

        <label class="form-label">
          <span>Your name *</span>
          <input class="input-field" name="name" required value={editingRsvp.name} autocomplete="name" />
        </label>

        <label class="form-label">
          <span>Email (optional)</span>
          <input
            class="input-field"
            type="email"
            name="email"
            placeholder="you@example.com"
            value={editingRsvp.email ?? ''}
            autocomplete="email"
          />
        </label>

        <div class="status-section">
          <span class="status-label">Response status *</span>
          <div class="status-options">
            <label class="status-option">
              <input
                type="radio"
                name="status"
                value="attending"
                checked={editingStatus === 'attending'}
                onchange={() => editingStatus = 'attending'}
                required
              />
              <span>Attending</span>
            </label>
            <label class="status-option">
              <input
                type="radio"
                name="status"
                value="maybe"
                checked={editingStatus === 'maybe'}
                onchange={() => editingStatus = 'maybe'}
              />
              <span>Maybe</span>
            </label>
            <label class="status-option">
              <input
                type="radio"
                name="status"
                value="not_attending"
                checked={editingStatus === 'not_attending'}
                onchange={() => { editingStatus = 'not_attending'; responses = {}; }}
              />
              <span>Not Attending</span>
            </label>
          </div>
        </div>

        {#if event.questions.length > 0 && (editingStatus === 'attending' || editingStatus === 'maybe')}
          <div class="questions-section">
            <h3>Questions</h3>
            <div class="question-list">
              {#each event.questions as question}
                {#if question.type === 'text'}
                  <label class="form-label">
                    <span>{question.label}{question.required ? ' *' : ''}</span>
                    {#if question.description}
                      <small>{question.description}</small>
                    {/if}
                    <input
                      class="input-field"
                      name="response_{question.id}"
                      type="text"
                      value={responses[question.id] ?? ''}
                      required={question.required}
                      onchange={(e) => responses[question.id] = e.currentTarget.value}
                    />
                  </label>
                {:else if question.type === 'multiple_choice'}
                  <fieldset>
                    <legend>{question.label}{question.required ? ' *' : ''}</legend>
                    {#if question.description}
                      <small>{question.description}</small>
                    {/if}
                    {#each (question.options ?? []) as option}
                      <label class="radio-option">
                        <input
                          type="radio"
                          name="response_{question.id}"
                          value={option}
                          checked={responses[question.id] === option}
                          required={question.required}
                          onchange={(e) => responses[question.id] = e.currentTarget.value}
                        />
                        <span>{option}</span>
                      </label>
                    {/each}
                  </fieldset>
                {:else if question.type === 'checkbox'}
                  <fieldset>
                    <legend>{question.label}{question.required ? ' *' : ''}</legend>
                    {#if question.description}
                      <small>{question.description}</small>
                    {/if}
                    {#each (question.options ?? []) as option}
                      <label class="checkbox-option">
                        <input
                          type="checkbox"
                          name="response_{question.id}"
                          value={option}
                          checked={responses[question.id]?.includes(option)}
                          onchange={(e) => {
                            const currentVals = responses[question.id]?.split(',').filter(Boolean) ?? [];
                            if (e.currentTarget.checked) {
                              responses[question.id] = [...currentVals, option].join(',');
                            } else {
                              responses[question.id] = currentVals.filter(v => v !== option).join(',');
                            }
                          }}
                        />
                        <span>{option}</span>
                      </label>
                    {/each}
                  </fieldset>
                {:else if question.type === 'slots'}
                  <label class="form-label">
                    <span>{question.label}{question.required ? ' *' : ''}</span>
                    {#if question.description}
                      <small class="text-sm text-gray-600">{question.description}</small>
                    {/if}
                    <input
                      class="input-field"
                      name="response_{question.id}"
                      type="text"
                      value={responses[question.id] ?? ''}
                      required={question.required}
                      placeholder="What are you bringing?"
                      onchange={(e) => responses[question.id] = e.currentTarget.value}
                    />
                    {#if question.quantity}
                      <small class="text-sm text-gray-600">{question.responseCount} of {question.quantity} slots filled</small>
                    {/if}
                  </label>
                {:else if question.type === 'spotify_playlist'}
                  <div class="form-label">
                    <span>{question.label}{question.required ? ' *' : ''}</span>
                    {#if question.description}
                      <small class="text-sm text-gray-600">{question.description}</small>
                    {/if}
                    {#if question.songsPerUser}
                      <small class="text-sm text-gray-600 block mb-2">
                        You can add up to {question.songsPerUser} song{question.songsPerUser === 1 ? '' : 's'}.
                      </small>
                    {:else}
                      <small class="text-sm text-gray-600 block mb-2">Add as many songs as you'd like.</small>
                    {/if}
                    <SpotifySongSelector
                      name="response_{question.id}"
                      required={question.required}
                      value={responses[question.id] ?? ''}
                      eventCode={event.publicCode}
                      limit={question.songsPerUser ?? null}
                      playlistId={question.spotifyPlaylistId}
                      questionId={question.id}
                    />
                  </div>
                {/if}
              {/each}
            </div>
          </div>
        {/if}

        <div class="modal-actions">
          <button type="submit" class="btn-primary">Update RSVP</button>
          <button type="button" class="btn-secondary" onclick={closeEditModal}>Cancel</button>
        </div>
      </form>

      <form method="POST" action="?/cancelRsvp" class="cancel-form" use:enhance={() => {
        return async ({ result, update }) => {
          showCancelConfirm = false;
          if (result.type === 'success' && result.data?.success) {
            // Update reactive state
            rsvpCount = result.data.rsvpCount ?? rsvpCount - 1;
            if (result.data.rsvps) {
              rsvps = result.data.rsvps;
            }
            if (result.data.questionResponseCounts) {
              questionResponseCounts = result.data.questionResponseCounts as Record<string, number>;
            }
            // Close modal
            closeEditModal();
          }
          await update();
        };
      }}>
        <input type="hidden" name="rsvpId" value={editingRsvp.id} />
        <input type="hidden" name="pin" value={currentPin} />
        {#if showCancelConfirm}
          <div class="flex gap-2 justify-center">
            <button type="submit" class="btn-danger">Yes, Cancel RSVP</button>
            <button type="button" class="btn-secondary" onclick={() => showCancelConfirm = false}>Nevermind</button>
          </div>
        {:else}
          <button type="button" class="btn-danger" onclick={() => showCancelConfirm = true}>Cancel RSVP</button>
        {/if}
      </form>
    </div>
  </div>
{/if}

<!-- RSVP Form Modal -->
{#if showRsvpModal && !rsvpAtLimit}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    aria-label="Close RSVP dialog"
    onclick={closeRsvpModal}
    onkeydown={(event) => {
      if (event.key === 'Escape') {
        closeRsvpModal();
      }
    }}
  >
    <div
      class="modal large"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-rsvp-title"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <div class="modal-header">
        <h3 id="create-rsvp-title">RSVP to {event.title}</h3>
        <button class="close-btn" onclick={closeRsvpModal}>×</button>
      </div>
      
      {#if formType === 'rsvp' && message}
        <div class="error-banner">{message}</div>
      {/if}

      <form method="POST" action="?/rsvp" class="rsvp-form" use:enhance={() => {
        return async ({ result, update }) => {
          if (result.type === 'success' && result.data?.success) {
            // Update reactive state
            rsvpCount = result.data.rsvpCount ?? rsvpCount + 1;
            if (result.data.rsvps) {
              rsvps = result.data.rsvps;
            }
            if (result.data.questionResponseCounts) {
              questionResponseCounts = result.data.questionResponseCounts as Record<string, number>;
            }
            // Close modal
            showRsvpModal = false;
            responses = {};
          }
          await update();
        };
      }}>
        <label class="form-label">
          <span>Your name *</span>
          <input
            class="input-field"
            name="name"
            required
            value={values.name ?? ''}
            autocomplete="name"
            placeholder="Your full name"
          />
          {#if errors.name}
            <small class="text-red-600 text-sm">{errors.name[0]}</small>
          {/if}
        </label>

        <label class="form-label">
          <span>Email (optional but recommended)</span>
          <input
            class="input-field"
            type="email"
            name="email"
            value={values.email ?? ''}
            autocomplete="email"
            placeholder="you@example.com"
          />
          {#if errors.email}
            <small class="text-red-600 text-sm">{errors.email[0]}</small>
          {/if}
        </label>

        <label class="form-label">
          <span>Choose a PIN (4-6 digits) *</span>
          <input
            class="input-field"
            name="pin"
            type="text"
            inputmode="numeric"
            minlength="4"
            maxlength="6"
            required
            value={values.pin ?? ''}
            autocomplete="off"
          />
          <small class="text-sm text-gray-600">You'll need this PIN to manage your RSVP later.</small>
          {#if errors.pin}
            <small class="text-red-600 text-sm">{errors.pin[0]}</small>
          {/if}
        </label>

        <div class="status-section">
          <span class="status-label">Response status *</span>
          <div class="status-options">
            <label class="status-option">
              <input
                type="radio"
                name="status"
                value="attending"
                checked={newRsvpStatus === 'attending'}
                onchange={() => newRsvpStatus = 'attending'}
                required
              />
              <span>Attending</span>
            </label>
            <label class="status-option">
              <input
                type="radio"
                name="status"
                value="maybe"
                checked={newRsvpStatus === 'maybe'}
                onchange={() => newRsvpStatus = 'maybe'}
              />
              <span>Maybe</span>
            </label>
            <label class="status-option">
              <input
                type="radio"
                name="status"
                value="not_attending"
                checked={newRsvpStatus === 'not_attending'}
                onchange={() => { newRsvpStatus = 'not_attending'; responses = {}; }}
              />
              <span>Not Attending</span>
            </label>
          </div>
        </div>

        {#if event.questions.length > 0 && (newRsvpStatus === 'attending' || newRsvpStatus === 'maybe')}
          <div class="questions-section">
            <h3>Questions</h3>

            <div class="question-list">
              {#each event.questions as question}
                {@const isFull = question.quantity && question.responseCount >= question.quantity}
                {@const isRequired = question.required && !isFull}
                
                {#if question.type === 'text'}
                  <label class="form-label" class:disabled={isFull}>
                    <span>
                      {question.label}{isRequired ? ' *' : ''}
                      {#if isFull}
                        <span class="badge-danger ml-2">Full</span>
                      {/if}
                    </span>
                    {#if question.description}
                      <small class="text-sm text-gray-600">{question.description}</small>
                    {/if}
                    <input
                      class="input-field"
                      name="response_{question.id}"
                      type="text"
                      value={responses[question.id] ?? ''}
                      required={isRequired}
                      disabled={isFull}
                      placeholder={isFull ? 'This question is at capacity' : ''}
                      onchange={(e) => responses[question.id] = e.currentTarget.value}
                    />
                  </label>
                {:else if question.type === 'multiple_choice'}
                  <fieldset class:disabled={isFull}>
                    <legend class="form-label">
                      {question.label}{isRequired ? ' *' : ''}
                      {#if isFull}
                        <span class="badge-danger ml-2">Full</span>
                      {/if}
                    </legend>
                    {#if question.description}
                      <small class="text-sm text-gray-600">{question.description}</small>
                    {/if}
                    {#each (question.options ?? []) as option}
                      <label class="radio-option">
                        <input
                          type="radio"
                          name="response_{question.id}"
                          value={option}
                          checked={responses[question.id] === option}
                          required={isRequired}
                          disabled={isFull}
                          onchange={(e) => responses[question.id] = e.currentTarget.value}
                        />
                        <span>{option}</span>
                      </label>
                    {/each}
                  </fieldset>
                {:else if question.type === 'checkbox'}
                  <fieldset class:disabled={isFull}>
                    <legend class="form-label">
                      {question.label}{isRequired ? ' *' : ''}
                      {#if isFull}
                        <span class="badge-danger ml-2">Full</span>
                      {/if}
                    </legend>
                    {#if question.description}
                      <small class="text-sm text-gray-600">{question.description}</small>
                    {/if}
                    {#each (question.options ?? []) as option}
                      <label class="checkbox-option">
                        <input
                          type="checkbox"
                          name="response_{question.id}"
                          value={option}
                          checked={responses[question.id]?.includes(option)}
                          disabled={isFull}
                          onchange={(e) => {
                            const currentVals = responses[question.id]?.split(',').filter(Boolean) ?? [];
                            if (e.currentTarget.checked) {
                              responses[question.id] = [...currentVals, option].join(',');
                            } else {
                              responses[question.id] = currentVals.filter(v => v !== option).join(',');
                            }
                          }}
                        />
                        <span>{option}</span>
                      </label>
                    {/each}
                  </fieldset>
                {:else if question.type === 'slots'}
                  <label class="form-label" class:disabled={isFull}>
                    <span>
                      {question.label}{isRequired ? ' *' : ''}
                      {#if isFull}
                        <span class="badge-danger ml-2">Full</span>
                      {/if}
                    </span>
                    {#if question.description}
                      <small class="text-sm text-gray-600">{question.description}</small>
                    {/if}
                    <input
                      class="input-field"
                      name="response_{question.id}"
                      type="text"
                      value={responses[question.id] ?? ''}
                      required={isRequired}
                      disabled={isFull}
                      placeholder={isFull ? 'All slots are taken' : 'What are you bringing?'}
                      onchange={(e) => responses[question.id] = e.currentTarget.value}
                    />
                    {#if question.quantity}
                      <small class="text-sm" class:text-red-600={isFull} class:text-gray-600={!isFull}>{question.responseCount} of {question.quantity} slots filled</small>
                    {/if}
                  </label>
                {:else if question.type === 'spotify_playlist'}
                  <div class="form-label">
                    <span>
                      {question.label}{isRequired ? ' *' : ''}
                      {#if isFull}
                        <span class="badge-danger ml-2">Full</span>
                      {/if}
                    </span>
                    {#if question.description}
                      <small class="text-sm text-gray-600">{question.description}</small>
                    {/if}
                    {#if question.songsPerUser}
                      <small class="text-sm text-gray-600 block mb-2">
                        You can add up to {question.songsPerUser} song{question.songsPerUser === 1 ? '' : 's'}.
                      </small>
                    {:else}
                      <small class="text-sm text-gray-600 block mb-2">Add as many songs as you'd like.</small>
                    {/if}
                    <SpotifySongSelector
                      name="response_{question.id}"
                      required={isRequired}
                      value={responses[question.id] ?? ''}
                      eventCode={event.publicCode}
                      limit={question.songsPerUser ?? null}
                      playlistId={question.spotifyPlaylistId}
                      questionId={question.id}
                    />
                  </div>
                {/if}
              {/each}
            </div>
          </div>
        {/if}

        <div class="modal-actions">
          <button type="submit" class="btn-primary w-full">Confirm RSVP</button>
          <button type="button" class="btn-secondary w-full" onclick={closeRsvpModal}>Cancel</button>
        </div>
      </form>
    </div>
  </div>
{/if}
