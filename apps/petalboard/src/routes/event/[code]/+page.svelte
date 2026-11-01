<script lang="ts">
	import { enhance } from "$app/forms";
	import { invalidateAll, replaceState } from "$app/navigation";
	import { env } from "$env/dynamic/public";
	import PlusOnesField, {
		newPerson,
		peopleFor,
		type Person,
	} from "$lib/components/PlusOnesField.svelte";
	import PotluckField from "$lib/components/PotluckField.svelte";
	import SpotifySongSelector from "$lib/components/SpotifySongSelector.svelte";
	import { directionsUrl, headcount } from "$lib/eventDetails";
	import { applyEventTheme, eventTheme, mixColors, withAlpha } from "$lib/eventTheme";
	import { partyLabel } from "$lib/guests";
	import { LIST_PREVIEW_SIZE, previewList } from "$lib/listPreview";
	import { parsePotluckAnswer, slotStatuses, type PotluckView } from "$lib/potluck";
	import { formatDate, formatShortDate } from "$lib/utils/format";
	import { loadGoogleMaps } from "$lib/utils/googleMaps";
	import { renderMarkdown } from "$lib/utils/markdown";
	import { onMount, tick } from "svelte";
	import { SvelteSet } from "svelte/reactivity";

	import type { ActionData, PageData } from "./$types";

	interface RsvpMutation {
		success?: boolean;
		rsvps?: PageData["rsvps"];
		rsvpCount?: number;
		totalGuests?: number;
		questionResponseCounts?: Record<string, number>;
	}

	function toRsvpStatus(status: string): RsvpStatus {
		return status === "maybe" || status === "not_attending" ? status : "attending";
	}

	function submittedGuestNames(data: unknown): string[] | null {
		if (
			typeof data !== "object" ||
			data === null ||
			!("guestNames" in data) ||
			!Array.isArray(data.guestNames) ||
			!data.guestNames.every((name) => typeof name === "string")
		) {
			return null;
		}

		return data.guestNames;
	}

	const { data, form }: { data: PageData; form: ActionData | null } = $props();
	const event = $derived(data.event);
	const isOwner = $derived(data.isOwner);
	const myRsvp = $derived(data.myRsvp);

	const theme = $derived(eventTheme(event));
	const primaryColors = $derived(theme.primaryColors);
	const secondaryColors = $derived(theme.secondaryColors);
	const themeVars = $derived(theme.themeVars);

	const colorStyles = $derived(
		Object.entries(themeVars)
			.map(([key, value]) => `${key}: ${value};`)
			.join("\n"),
	);

	// Apply event colors to the document root for layout theming
	$effect(() => applyEventTheme(themeVars, event));

	// Make rsvps reactive so we can update without reload
	let rsvps = $derived(data.rsvps);
	let rsvpCount = $derived(data.event.rsvpCount);
	let totalGuests = $derived(data.event.totalGuests);
	let questionResponseCounts = $derived<Record<string, number>>(
		Object.fromEntries(event.questions.map((q: any) => [q.id, q.responseCount])),
	);

	const people = $derived(headcount(rsvps));
	const potluckViews = $derived<Record<string, PotluckView>>(
		Object.fromEntries(event.questions.flatMap((q: any) => (q.potluck ? [[q.id, q.potluck]] : []))),
	);
	const potluckRejection = $derived<{
		formType: string;
		questionId: string;
		offered: string[];
	} | null>((form as any)?.potluck ? { ...(form as any).potluck, formType: form?.type } : null);
	const offeredAfterRejection = (formType: string, questionId: string) =>
		potluckRejection?.formType === formType && potluckRejection.questionId === questionId
			? potluckRejection.offered
			: null;

	const errors = $derived<Record<string, string[]>>(
		(form?.errors ?? {}) as Record<string, string[]>,
	);
	const values = $derived<Record<string, string>>(form?.values ?? {});
	const message = $derived<string | null>(form?.message ?? null);
	const success = $derived(form?.success ?? false);
	const formType = $derived(form?.type ?? null);

	// Initialize responses with required question IDs
	const requiredQuestionIds = $derived(
		event.questions.filter((q: any) => q.required).map((q: any) => q.id),
	);

	let responses = $state<Record<string, string>>({});
	let showRsvpModal = $state(false);
	let showEditModal = $state(false);
	let editingRsvp = $state<any>(null);
	let lastFormType = $state<string | null>(null);
	let showLinkModal = $state(false);
	let linkResult = $state<{ ok: boolean; message: string } | null>(null);
	let linkEmailInput = $state<HTMLInputElement>();
	let linkStatus = $state<HTMLElement>();
	let sendingLink = $state(false);
	let editNameInput = $state<HTMLInputElement>();
	let linkTrigger: HTMLElement | null = null;
	let editingStatus = $state<RsvpStatus>("attending");
	let editingPeople = $state<Person[]>([]);
	let newRsvpStatus = $state<RsvpStatus>("attending");
	let newPeople = $state<Person[]>([]);
	let showCancelConfirm = $state(false);
	let submittingRsvp = $state(false);
	const expandedLists = new SvelteSet<string>();

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
		if (typeof document !== "undefined") {
			if (showRsvpModal || showEditModal || showLinkModal) {
				document.body.classList.add("no-scroll");
			} else {
				document.body.classList.remove("no-scroll");
			}
		}
	});

	let mapLoadRequested = false;

	const requestMapLoad = async () => {
		if (mapLoadRequested) {
			return;
		}

		mapLoadRequested = true;

		const apiKey = env.PUBLIC_GOOGLE_MAPS_API_KEY;

		if (!event.location || !apiKey || apiKey === "your-google-maps-api-key") {
			return;
		}

		try {
			await loadGoogleMaps(apiKey);
			await initializeMap();
		} catch (err) {
			console.error("Failed to load map:", err);
		}
	};

	// Lazily initialize the map when it comes into view
	onMount(() => {
		if (!event.location) {
			return;
		}

		let observer: IntersectionObserver | null = null;

		const setupObserver = async () => {
			await tick();

			if (typeof window === "undefined" || !mapElement) {
				requestMapLoad();

				return;
			}

			if ("IntersectionObserver" in window) {
				observer = new IntersectionObserver(
					(entries) => {
						const isVisible = entries.some((entry) => entry.isIntersecting);

						if (isVisible) {
							observer?.disconnect();

							// Performance: Delay map loading slightly to prioritize LCP
							if ("requestIdleCallback" in window) {
								requestIdleCallback(() => requestMapLoad(), { timeout: 1000 });
							} else {
								setTimeout(() => requestMapLoad(), 200);
							}
						}
					},
					{ rootMargin: "200px 0px" },
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
		if (!event.location || !mapElement) {
			return;
		}

		try {
			// Geocode the address
			const geocoder = new google.maps.Geocoder();
			const result = await geocoder.geocode({ address: event.location });

			if (result.results[0]) {
				const location = result.results[0].geometry.location;

				const { Map } = await google.maps.importLibrary("maps");
				const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

				map = new Map(mapElement, {
					center: location,
					zoom: 15,
					mapId: "EVENT_MAP_ID",
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
			console.error("Failed to geocode address:", err);
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

	type RsvpStatus = "attending" | "maybe" | "not_attending";

	interface PlaylistEntry {
		key: string;
		track: ParsedSpotifyTrack;
		contributor: string;
	}

	function buildPlaylistEntries(
		responses: { name: string; status: string; value: string }[],
		status: RsvpStatus,
	): PlaylistEntry[] {
		if (!responses || responses.length === 0) {
			return [];
		}

		return responses
			.filter((response) => response.status === status)
			.flatMap((response, responseIndex) => {
				const guestName = response.name ?? "Guest";
				const tracks = parseSpotifyTracks(response.value);

				return tracks.map((track, trackIndex) => ({
					key: `${status}-${guestName}-${track.id}-${responseIndex}-${trackIndex}`,
					track,
					contributor: guestName,
				}));
			});
	}

	function handleOverlayKeydown(event: KeyboardEvent, action: () => void) {
		if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
			event.preventDefault();
			action();
		}
	}

	function closeTopDialog(event: KeyboardEvent) {
		if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) {
			return;
		}

		if (showLinkModal) {
			closeLinkModal();
		} else if (showEditModal) {
			closeEditModal();
		} else if (showRsvpModal) {
			closeRsvpModal();
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
					if (!track || typeof track !== "object") {
						return null;
					}

					const name = typeof track.name === "string" ? track.name : "Unknown track";
					const rawArtists = Array.isArray(track.artists)
						? track.artists
								.map((artist: any) =>
									artist && typeof artist === "object" && typeof artist.name === "string"
										? artist.name
										: null,
								)
								.filter((artist: any): artist is string => Boolean(artist))
						: [];
					const album =
						track.album && typeof track.album === "object" && typeof track.album.name === "string"
							? track.album.name
							: null;
					const images =
						track.album && typeof track.album === "object" && Array.isArray(track.album.images)
							? track.album.images
							: [];
					const image =
						images?.[1]?.url ?? images?.[0]?.url ?? images?.[images.length - 1]?.url ?? null;
					const spotifyUrl =
						track.external_urls &&
						typeof track.external_urls === "object" &&
						typeof track.external_urls.spotify === "string"
							? track.external_urls.spotify
							: null;
					const id =
						(typeof track.id === "string" && track.id) ||
						(typeof track.uri === "string" && track.uri) ||
						`${name}:${rawArtists.join(",")}`;

					return {
						id,
						name,
						artists: rawArtists.join(", ") || "Unknown artist",
						album,
						image,
						spotifyUrl,
					} satisfies ParsedSpotifyTrack;
				})
				.filter((track): track is ParsedSpotifyTrack => Boolean(track));
		} catch (error) {
			console.warn("Failed to parse Spotify response value", error);

			return [];
		}
	}

	// Track form changes and update state accordingly
	$effect(() => {
		const currentFormType = form?.type ?? null;

		// Only process if form type changed
		if (currentFormType === lastFormType) {
			return;
		}

		lastFormType = currentFormType;

		if ((form?.type === "updateRsvp" || form?.type === "cancelRsvp") && form.success) {
			closeEditModal();
		}

		if (form?.type === "rsvp" && form.success) {
			showRsvpModal = false;
			newRsvpStatus = "attending";
			newPeople = [];
			responses = {};
		}
	});

	$effect(() => {
		if (form?.type === "rsvp" && !form.success && form.guestNames) {
			newPeople = form.guestNames.map((name) => newPerson(name));
		}
	});

	$effect(() => {
		if (form?.type === "rsvp" && !form.success && !form.alreadyRegistered) {
			showRsvpModal = true;
		}
	});

	const rsvpAtLimit = $derived(event.rsvpLimit !== null && totalGuests >= event.rsvpLimit);

	function openRsvpModal() {
		showRsvpModal = true;
		responses = {};
		newRsvpStatus = "attending";
		newPeople = [];
	}

	function closeRsvpModal() {
		showRsvpModal = false;
		responses = {};
		newRsvpStatus = "attending";
		newPeople = [];
	}

	async function openEditModal() {
		if (!myRsvp) {
			return;
		}

		editingRsvp = myRsvp;
		responses = { ...myRsvp.responses };
		editingStatus = toRsvpStatus(myRsvp.status);
		editingPeople = peopleFor(myRsvp.guestCount, myRsvp.guestNames);
		showEditModal = true;
		await tick();
		editNameInput?.focus();
	}

	function closeEditModal() {
		editingRsvp = null;
		showEditModal = false;
		responses = {};
		editingStatus = "attending";
		editingPeople = [];
	}

	async function openLinkModal(trigger: HTMLElement) {
		linkTrigger = trigger;
		linkResult = null;
		showLinkModal = true;
		await tick();
		linkEmailInput?.focus();
	}

	function closeLinkModal() {
		showLinkModal = false;
		linkResult = null;
		linkTrigger?.focus();
	}

	onMount(async () => {
		const url = new URL(window.location.href);

		if (url.searchParams.get("edit") !== "1") {
			return;
		}

		await openEditModal();
		// Without this, a reload or a shared copy of the URL reopens the dialog.
		url.searchParams.delete("edit");
		replaceState(url, {});
	});

	async function expandList(key: string, button: HTMLElement) {
		const list = button.parentElement;

		expandedLists.add(key);
		await tick();
		const revealed = list?.querySelectorAll<HTMLElement>(".panel-list-item")[LIST_PREVIEW_SIZE];

		if (!revealed) {
			return;
		}

		const control = revealed.querySelector<HTMLElement>("a[href], button");

		if (control) {
			control.focus();
		} else {
			revealed.tabIndex = -1;
			revealed.focus();
		}
	}
</script>

<svelte:head>
	<title>{event.title} - PetalBoard</title>
</svelte:head>

<svelte:window onkeydown={closeTopDialog} />

{#snippet showAll(key: string, total: number, extraClass: string)}
	{#if total > LIST_PREVIEW_SIZE && !expandedLists.has(key)}
		<button
			type="button"
			class="btn-secondary w-full {extraClass}"
			onclick={(event) => expandList(key, event.currentTarget)}>Show all {total}</button
		>
	{/if}
{/snippet}

<div class="event-page-wrapper mx-auto min-h-screen max-w-4xl px-4 py-8" style={colorStyles}>
	<!-- Event Header with RSVP Button -->
	<article class="card event-card mb-8">
		<div class="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
			<div class="flex-1">
				<h1 class="mb-4 text-4xl font-bold text-dark-900 md:text-4xl">
					{#if event.emoji}
						<span class="mr-2">{event.emoji}</span>
					{/if}
					{event.title}
				</h1>
				<div class="mb-4 flex flex-col gap-2">
					<p class="prose m-0 text-sm text-dark-700 md:text-base">
						📅 {formatDate(event.date, event.timezone)}
						<a class="ml-1 whitespace-nowrap" href="/event/{event.publicCode}/calendar.ics" download
							>Add to calendar</a
						>
					</p>
					{#if event.endDate}
						<p class="m-0 text-sm text-dark-700 md:text-base">
							⏰ Until {formatShortDate(event.endDate, event.timezone)}
						</p>
					{/if}
					{#if event.location}
						<div class="flex flex-col gap-3">
							<p class="prose m-0 break-words text-sm text-dark-700 md:text-base">
								📍 {event.location}
								<a
									class="ml-1 whitespace-nowrap"
									href={directionsUrl(event.location)}
									target="_blank"
									rel="noreferrer">Directions</a
								>
							</p>
							{#if env.PUBLIC_GOOGLE_MAPS_API_KEY && env.PUBLIC_GOOGLE_MAPS_API_KEY !== "your-google-maps-api-key"}
								<a href="#after-map" class="sr-only text-sm underline focus:not-sr-only">Skip map</a
								>
								<div
									class="h-[200px] w-full overflow-hidden rounded-xl shadow-card"
									bind:this={mapElement}
								></div>
							{/if}
						</div>
					{/if}
					<p id="after-map" class="m-0 text-sm text-dark-700 md:text-base" tabindex="-1">
						👥 {people.coming}
						{people.coming === 1 ? "person" : "people"} coming{#if people.maybe > 0}, {people.maybe}
							maybe{/if}
					</p>
				</div>
				{#if event.description}
					<div
						class="prose prose-sm md:prose-base my-4 max-w-none text-sm leading-relaxed text-dark-800 md:text-base"
					>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown sanitizes its HTML. -->
						{@html renderMarkdown(event.description)}
					</div>
				{/if}
				<div class="mt-4 flex flex-wrap gap-2">
					{#if event.rsvpLimit}
						<span
							class="badge-status"
							data-tone={rsvpAtLimit ? undefined : "theme"}
							style={rsvpAtLimit
								? "background: rgba(254, 226, 226, 0.92); color: #991b1b; border: 1px solid rgba(185, 28, 28, 0.25);"
								: `background-color: ${mixColors(primaryColors[100], secondaryColors[100], 0.55, 0.9)}; color: ${primaryColors[800]}; border: 1px solid ${withAlpha(primaryColors[600], 0.18)};`}
						>
							{totalGuests} / {event.rsvpLimit} guests
						</span>
					{:else}
						<span
							class="badge-status"
							data-tone="theme"
							style={`background-color: ${mixColors(primaryColors[100], secondaryColors[100], 0.55, 0.9)}; color: ${primaryColors[800]}; border: 1px solid ${withAlpha(primaryColors[600], 0.18)};`}
						>
							{rsvpCount}
							{rsvpCount === 1 ? "RSVP" : "RSVPs"}{#if totalGuests > rsvpCount}
								({totalGuests} guests){/if}
						</span>
					{/if}
				</div>
			</div>

			<div class="flex w-full flex-col gap-3 md:w-auto">
				{#if !rsvpAtLimit}
					<button
						class="w-full rounded-xl px-6 py-3 text-base font-semibold text-white shadow-button transition-colors md:w-auto md:px-8 md:py-4 md:text-lg"
						style={`background: linear-gradient(135deg, ${primaryColors[700]}, ${secondaryColors[700]}); box-shadow: 0 14px 28px ${withAlpha(primaryColors[600], 0.33)};`}
						onmouseover={(e) =>
							(e.currentTarget.style.background = `linear-gradient(135deg, ${primaryColors[800]}, ${secondaryColors[800]})`)}
						onmouseout={(e) =>
							(e.currentTarget.style.background = `linear-gradient(135deg, ${primaryColors[700]}, ${secondaryColors[700]})`)}
						onfocus={(e) =>
							(e.currentTarget.style.background = `linear-gradient(135deg, ${primaryColors[800]}, ${secondaryColors[800]})`)}
						onblur={(e) =>
							(e.currentTarget.style.background = `linear-gradient(135deg, ${primaryColors[700]}, ${secondaryColors[700]})`)}
						onclick={openRsvpModal}
					>
						RSVP Now
					</button>
				{/if}
				{#if myRsvp}
					<button type="button" class="btn-secondary min-h-11" onclick={openEditModal}
						>Edit my RSVP</button
					>
				{:else}
					<button
						type="button"
						class="btn-secondary min-h-11"
						onclick={(e) => openLinkModal(e.currentTarget)}>Already RSVP'd? Edit my RSVP</button
					>
				{/if}
			</div>
		</div>
	</article>

	<!-- Success Messages -->
	{#if success && formType === "rsvp"}
		<div
			class="success-banner event-card"
			style={`border: 1px solid ${withAlpha(secondaryColors[600], 0.32)}; background-color: ${mixColors(primaryColors[50], secondaryColors[50], 0.6, 0.78)};`}
		>
			<h2 class="mb-2 text-xl font-bold">✅ You're all set!</h2>
			<p class="mb-0">
				Check your email for a confirmation with a link to edit your RSVP. This browser can also
				edit it any time with Edit my RSVP.
			</p>
		</div>
	{/if}

	{#if formType === "rsvp" && form?.alreadyRegistered}
		<div
			class="card event-card mb-8"
			role="status"
			style={`border: 1px solid ${withAlpha(secondaryColors[600], 0.32)}; background-color: ${mixColors(primaryColors[50], secondaryColors[50], 0.6, 0.78)};`}
		>
			<h2 class="mb-2 text-xl font-bold">Check your email</h2>
			<p class="mb-0">{message}</p>
		</div>
	{/if}

	{#if success && formType === "updateRsvp"}
		<div
			class="success-banner event-card"
			style={`border: 1px solid ${withAlpha(secondaryColors[600], 0.32)}; background-color: ${mixColors(primaryColors[50], secondaryColors[50], 0.6, 0.78)};`}
		>
			<h2 class="mb-2 text-xl font-bold">✅ Updated!</h2>
			<p class="mb-0">{message}</p>
		</div>
	{/if}

	{#if success && formType === "cancelRsvp"}
		<div
			class="card event-card mb-8"
			style={`border: 1px solid ${withAlpha(secondaryColors[600], 0.32)}; background-color: ${mixColors(primaryColors[50], secondaryColors[50], 0.6, 0.78)};`}
		>
			<h2 class="mb-2 text-xl font-bold">RSVP Cancelled</h2>
			<p class="mb-0">{message}</p>
		</div>
	{/if}

	<!-- WHO'S COMING - Public View -->
	{#if rsvps && rsvps.length > 0}
		{@const attendingList = rsvps.filter((r: any) => r.status === "attending")}
		{@const maybeList = rsvps.filter((r: any) => r.status === "maybe")}
		{@const notAttendingList = rsvps.filter((r: any) => r.status === "not_attending")}

		<section class="card event-card mb-8">
			<h2 class="mb-6 text-xl font-bold text-dark-900 md:text-2xl">
				Who's Coming ({attendingList.length} attending, {maybeList.length} maybe)
			</h2>

			<!-- RSVPs List -->
			<div class="flex flex-col gap-4">
				<!-- Attending Section -->
				{#if attendingList.length > 0}
					<details
						class="panel tone-attending overflow-hidden"
						open={showAttending}
						ontoggle={(e) => (showAttending = (e.target as HTMLDetailsElement)?.open ?? false)}
					>
						<summary
							class="flex cursor-pointer select-none list-none items-center justify-between px-4 py-3.5 text-base font-semibold transition-all hover:opacity-90 md:px-6 md:py-4 md:text-lg"
						>
							<span class="flex items-center gap-2">
								<span
									class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm"
									style={`background-color: ${primaryColors[700]}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.28)};`}
									>✓</span
								>
								Attending ({attendingList.length})
							</span>
							<span class="chevron-icon text-sm opacity-60">▼</span>
						</summary>
						<div class="panel-body event-section grid gap-3 p-4 pt-3 md:p-6 md:pt-4">
							{#each previewList(attendingList, expandedLists.has("attending")) as rsvp}
								<div
									class="panel-list-item flex items-center justify-between gap-3 rounded-xl border p-3 transition-all hover:shadow-md md:gap-4 md:p-4"
								>
									<div class="flex min-w-0 flex-1 flex-col gap-1">
										<strong class="truncate text-sm text-dark-900 md:text-base"
											>{rsvp.name}{#if rsvp.guestCount > 1 && rsvp.guestNames.length === 0}
												<span class="font-normal text-dark-600"
													>(+{rsvp.guestCount - 1} guest{rsvp.guestCount - 1 === 1
														? ""
														: "s"})</span
												>{/if}</strong
										>
										{#if rsvp.guestNames.length > 0}
											<span class="text-xs text-dark-600 md:text-sm"
												>with {partyLabel(rsvp.guestCount, rsvp.guestNames)}</span
											>
										{/if}
										{#if rsvp.email && isOwner}
											<span class="truncate text-xs text-dark-700 md:text-sm">{rsvp.email}</span>
										{/if}
										<span class="text-xs text-dark-600"
											>{formatShortDate(rsvp.createdAt, event.timezone)}</span
										>
									</div>
									{#if rsvp.id === myRsvp?.id}
										<button
											type="button"
											class="inline-flex min-h-11 min-w-11 flex-shrink-0 cursor-pointer items-center justify-center border-none bg-none p-2 text-xl opacity-60 transition-opacity hover:opacity-100"
											title="Edit my RSVP"
											aria-label="Edit my RSVP"
											onclick={openEditModal}
										>
											✏️
										</button>
									{/if}
								</div>
							{/each}
							{@render showAll("attending", attendingList.length, "")}
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
						<summary
							class="flex cursor-pointer select-none list-none items-center justify-between px-4 py-3.5 text-base font-semibold transition-all hover:opacity-90 md:px-6 md:py-4 md:text-lg"
						>
							<span class="flex items-center gap-2">
								<span
									class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm"
									style={`background-color: ${secondaryColors[700]}; color: white; box-shadow: 0 2px 8px ${withAlpha(secondaryColors[600], 0.25)};`}
									>?</span
								>
								Maybe ({maybeList.length})
							</span>
							<span class="chevron-icon text-sm opacity-60">▼</span>
						</summary>
						<div class="panel-body event-section grid gap-3 p-4 pt-3 md:p-6 md:pt-4">
							{#each previewList(maybeList, expandedLists.has("maybe")) as rsvp}
								<div
									class="panel-list-item flex items-center justify-between gap-3 rounded-xl border p-3 transition-all hover:shadow-md md:gap-4 md:p-4"
								>
									<div class="flex min-w-0 flex-1 flex-col gap-1">
										<strong class="truncate text-sm text-dark-900 md:text-base"
											>{rsvp.name}{#if rsvp.guestCount > 1 && rsvp.guestNames.length === 0}
												<span class="font-normal text-dark-600"
													>(+{rsvp.guestCount - 1} guest{rsvp.guestCount - 1 === 1
														? ""
														: "s"})</span
												>{/if}</strong
										>
										{#if rsvp.guestNames.length > 0}
											<span class="text-xs text-dark-600 md:text-sm"
												>with {partyLabel(rsvp.guestCount, rsvp.guestNames)}</span
											>
										{/if}
										{#if rsvp.email && isOwner}
											<span class="truncate text-xs text-dark-700 md:text-sm">{rsvp.email}</span>
										{/if}
										<span class="text-xs text-dark-600"
											>{formatShortDate(rsvp.createdAt, event.timezone)}</span
										>
									</div>
									{#if rsvp.id === myRsvp?.id}
										<button
											type="button"
											class="inline-flex min-h-11 min-w-11 flex-shrink-0 cursor-pointer items-center justify-center border-none bg-none p-2 text-xl opacity-60 transition-opacity hover:opacity-100"
											title="Edit my RSVP"
											aria-label="Edit my RSVP"
											onclick={openEditModal}
										>
											✏️
										</button>
									{/if}
								</div>
							{/each}
							{@render showAll("maybe", maybeList.length, "")}
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
						<summary
							class="flex cursor-pointer select-none list-none items-center justify-between px-4 py-3.5 text-base font-semibold transition-all hover:opacity-80 md:px-6 md:py-4 md:text-lg"
						>
							<span class="flex items-center gap-2">
								<span
									class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm"
									style={`background-color: ${withAlpha(primaryColors[700], 0.8)}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.18)};`}
									>✗</span
								>
								Not Attending ({notAttendingList.length})
							</span>
							<span class="chevron-icon text-sm opacity-60">▼</span>
						</summary>
						<div class="panel-body event-section grid gap-3 p-4 pt-3 md:p-6 md:pt-4">
							{#each previewList(notAttendingList, expandedLists.has("not-attending")) as rsvp}
								<div
									class="panel-list-item flex items-center justify-between gap-3 rounded-xl border p-3 transition-all hover:shadow-md md:gap-4 md:p-4"
								>
									<div class="flex min-w-0 flex-1 flex-col gap-1">
										<strong class="truncate text-sm text-dark-900 md:text-base"
											>{rsvp.name}{#if rsvp.guestCount > 1 && rsvp.guestNames.length === 0}
												<span class="font-normal text-dark-600"
													>(+{rsvp.guestCount - 1} guest{rsvp.guestCount - 1 === 1
														? ""
														: "s"})</span
												>{/if}</strong
										>
										{#if rsvp.guestNames.length > 0}
											<span class="text-xs text-dark-600 md:text-sm"
												>with {partyLabel(rsvp.guestCount, rsvp.guestNames)}</span
											>
										{/if}
										{#if rsvp.email && isOwner}
											<span class="truncate text-xs text-dark-700 md:text-sm">{rsvp.email}</span>
										{/if}
										<span class="text-xs text-dark-600"
											>{formatShortDate(rsvp.createdAt, event.timezone)}</span
										>
									</div>
									{#if rsvp.id === myRsvp?.id}
										<button
											type="button"
											class="inline-flex min-h-11 min-w-11 flex-shrink-0 cursor-pointer items-center justify-center border-none bg-none p-2 text-xl opacity-60 transition-opacity hover:opacity-100"
											title="Edit my RSVP"
											aria-label="Edit my RSVP"
											onclick={openEditModal}
										>
											✏️
										</button>
									{/if}
								</div>
							{/each}
							{@render showAll("not-attending", notAttendingList.length, "")}
						</div>
					</details>
				{/if}
			</div>
		</section>
	{/if}

	{#each event.questions.filter((q: any) => potluckViews[q.id]) as question (question.id)}
		{@const view = potluckViews[question.id]}
		{@const dishTotal = Object.values(view.counts).reduce((sum, n) => sum + n, 0)}
		<section class="card event-card mb-8">
			<div
				class="mb-6 flex flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between md:gap-4"
				style="border-color: {primaryColors[600]}20;"
			>
				<h2 class="m-0 text-xl font-bold text-dark-900 md:text-2xl">{question.label}</h2>
				<span
					class="badge-status"
					data-tone="theme"
					style="background-color: {primaryColors[100]}; color: {primaryColors[800]};"
				>
					{dishTotal}
					{dishTotal === 1 ? "dish" : "dishes"}
				</span>
			</div>
			{#if view.config.providing}
				<p class="m-0 mb-4 text-sm text-dark-700 md:text-base">
					<strong>Hosts are providing:</strong>
					{view.config.providing}
				</p>
			{/if}
			<ul class="m-0 flex list-none flex-col gap-4 p-0">
				{#each slotStatuses(view.config, view.counts) as slot (slot.category.id)}
					{@const dishes = view.taken.filter((t) => t.category === slot.category.id)}
					<li>
						<div class="flex items-center justify-between gap-3">
							<strong class="text-sm text-dark-900 md:text-base">{slot.category.label}</strong>
							<span class="flex items-center gap-2 text-sm text-dark-600">
								{slot.count}
								{#if slot.status === "needed-most"}
									<span
										class="badge-status px-3 py-1 text-xs"
										data-tone="theme"
										style="background-color: {primaryColors[100]}; color: {primaryColors[800]};"
										>Needed most</span
									>
								{:else if slot.status === "full"}
									<span
										class="badge-status px-3 py-1 text-xs"
										data-tone="theme"
										style="background-color: transparent; color: {primaryColors[800]}; border: 1px solid {withAlpha(
											primaryColors[600],
											0.3,
										)};">Full for now</span
									>
								{/if}
							</span>
						</div>
						{#if dishes.length > 0}
							<p class="m-0 mt-1 text-sm text-dark-700">
								{dishes.map((d) => (d.name ? `${d.dish} (${d.name})` : d.dish)).join(", ")}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/each}

	<!-- Public Question Responses (All Types - In Creation Order) -->
	{#if event.questions.some((q: any) => q.isPublic && q.publicResponses && q.publicResponses.length > 0)}
		{@const publicQuestions = event.questions.filter(
			(q: any) => q.isPublic && q.publicResponses && q.publicResponses.length > 0,
		)}
		{#each publicQuestions as question}
			<section class="card event-card mb-8">
				<div
					class="mb-6 flex flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between md:gap-4"
					style="border-color: {primaryColors[600]}20;"
				>
					<h2 class="m-0 text-xl font-bold text-dark-900 md:text-2xl">{question.label}</h2>
					{#if question.quantity}
						<span
							class="badge-status"
							data-tone="theme"
							style="background-color: {primaryColors[100]}; color: {primaryColors[800]};"
						>
							{question.responseCount} of {question.quantity} slots filled
						</span>
					{:else}
						<span
							class="badge-status"
							data-tone="theme"
							style="background-color: {primaryColors[100]}; color: {primaryColors[800]};"
						>
							{question.responseCount}
							{question.responseCount === 1 ? "response" : "responses"}
						</span>
					{/if}
				</div>
				{#if question.description}
					<div class="prose prose-sm m-0 mb-6 max-w-none text-sm leading-relaxed text-dark-700">
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown sanitizes its HTML. -->
						{@html renderMarkdown(question.description)}
					</div>
				{/if}

				{#if question.type === "spotify_playlist"}
					<!-- Spotify Playlist Question -->
					<div class="flex flex-col gap-4">
						{#if question.publicResponses.some((r: any) => r.status === "attending")}
							{@const attendingTrackEntries = buildPlaylistEntries(
								question.publicResponses ?? [],
								"attending",
							)}
							<div class="panel-block tone-attending overflow-hidden">
								<h3
									class="panel-block-header m-0 flex items-center gap-2.5 px-5 py-3.5 text-sm font-semibold"
								>
									<span
										class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold"
										style={`background-color: ${primaryColors[700]}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.28)};`}
										>✓</span
									>
									Attending ({attendingTrackEntries.length}
									{attendingTrackEntries.length === 1 ? "song" : "songs"})
								</h3>
								<div class="panel-block-body px-5 py-4">
									{#if attendingTrackEntries.length > 0}
										<ul class="space-y-3">
											{#each previewList(attendingTrackEntries, expandedLists.has(`songs-${question.id}-attending`)) as entry, index (entry.key)}
												<li
													class="panel-list-item flex flex-col items-start gap-3 rounded-xl border p-3 transition-all hover:shadow-md sm:flex-row sm:items-center sm:gap-4 sm:p-4"
												>
													<div class="flex w-full items-center gap-3 sm:w-auto sm:gap-4">
														<span
															class="index-badge w-6 flex-shrink-0 text-center text-xs font-bold sm:w-8 sm:text-sm"
															style="color: {primaryColors[700]};">{index + 1}</span
														>
														{#if entry.track.image}
															<img
																src={entry.track.image}
																alt={entry.track.album
																	? `${entry.track.album} artwork`
																	: `${entry.track.name} artwork`}
																class="h-12 w-12 flex-shrink-0 rounded-lg object-cover shadow-sm sm:h-14 sm:w-14"
																loading="lazy"
															/>
														{/if}
														<div class="min-w-0 flex-1 space-y-0.5">
															<p class="truncate text-sm font-semibold text-dark-900">
																{#if entry.track.spotifyUrl}
																	<a
																		href={entry.track.spotifyUrl}
																		target="_blank"
																		rel="noreferrer"
																		class="hover:underline"
																	>
																		{entry.track.name}
																	</a>
																{:else}
																	{entry.track.name}
																{/if}
															</p>
															<p class="truncate text-xs text-dark-600">{entry.track.artists}</p>
															{#if entry.track.album}
																<p class="truncate text-xs text-dark-500">{entry.track.album}</p>
															{/if}
														</div>
													</div>
													<div class="flex flex-shrink-0 items-center gap-2 sm:ml-auto">
														<span
															class="contributor-chip inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-xs font-semibold"
															style="background-color: {primaryColors[100]}; color: {primaryColors[800]};"
														>
															<span aria-hidden="true">👤</span>
															<span class="hidden sm:inline">{entry.contributor}</span>
															<span class="sm:hidden">{entry.contributor.split(" ")[0]}</span>
														</span>
														<span
															class="song-note flex-shrink-0 text-lg sm:text-xl"
															style="color: {primaryColors[700]};"
															aria-hidden="true">♪</span
														>
													</div>
												</li>
											{/each}
										</ul>
										{@render showAll(
											`songs-${question.id}-attending`,
											attendingTrackEntries.length,
											"mt-3",
										)}
									{:else}
										<p class="text-sm italic text-gray-500">No songs yet from attendees.</p>
									{/if}
								</div>
							</div>
						{/if}

						{#if question.publicResponses.some((r: any) => r.status === "maybe")}
							{@const maybeTrackEntries = buildPlaylistEntries(
								question.publicResponses ?? [],
								"maybe",
							)}
							<div class="panel-block tone-maybe overflow-hidden">
								<h3
									class="panel-block-header m-0 flex items-center gap-2.5 px-5 py-3.5 text-sm font-semibold"
								>
									<span
										class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold"
										style={`background-color: ${secondaryColors[700]}; color: white; box-shadow: 0 2px 8px ${withAlpha(secondaryColors[600], 0.24)};`}
										>?</span
									>
									Maybe ({maybeTrackEntries.length}
									{maybeTrackEntries.length === 1 ? "song" : "songs"})
								</h3>
								<div class="panel-block-body px-5 py-4">
									{#if maybeTrackEntries.length > 0}
										<ul class="space-y-3">
											{#each previewList(maybeTrackEntries, expandedLists.has(`songs-${question.id}-maybe`)) as entry, index (entry.key)}
												<li
													class="panel-list-item flex flex-col items-start gap-3 rounded-xl border p-3 transition-all hover:shadow-md sm:flex-row sm:items-center sm:gap-4 sm:p-4"
												>
													<div class="flex w-full items-center gap-3 sm:w-auto sm:gap-4">
														<span
															class="index-badge w-6 flex-shrink-0 text-center text-xs font-bold sm:w-8 sm:text-sm"
															style="color: {primaryColors[700]};">{index + 1}</span
														>
														{#if entry.track.image}
															<img
																src={entry.track.image}
																alt={entry.track.album
																	? `${entry.track.album} artwork`
																	: `${entry.track.name} artwork`}
																class="h-12 w-12 flex-shrink-0 rounded-lg object-cover shadow-sm sm:h-14 sm:w-14"
																loading="lazy"
															/>
														{/if}
														<div class="min-w-0 flex-1 space-y-0.5">
															<p class="truncate text-sm font-semibold text-dark-900">
																{#if entry.track.spotifyUrl}
																	<a
																		href={entry.track.spotifyUrl}
																		target="_blank"
																		rel="noreferrer"
																		class="hover:underline"
																	>
																		{entry.track.name}
																	</a>
																{:else}
																	{entry.track.name}
																{/if}
															</p>
															<p class="truncate text-xs text-dark-600">{entry.track.artists}</p>
															{#if entry.track.album}
																<p class="truncate text-xs text-dark-500">{entry.track.album}</p>
															{/if}
														</div>
													</div>
													<div class="flex flex-shrink-0 items-center gap-2 sm:ml-auto">
														<span
															class="contributor-chip inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-xs font-semibold"
															style="background-color: {primaryColors[100]}; color: {primaryColors[800]};"
														>
															<span aria-hidden="true">👤</span>
															<span class="hidden sm:inline">{entry.contributor}</span>
															<span class="sm:hidden">{entry.contributor.split(" ")[0]}</span>
														</span>
														<span
															class="song-note flex-shrink-0 text-lg sm:text-xl"
															style="color: {primaryColors[700]};"
															aria-hidden="true">♪</span
														>
													</div>
												</li>
											{/each}
										</ul>
										{@render showAll(
											`songs-${question.id}-maybe`,
											maybeTrackEntries.length,
											"mt-3",
										)}
									{:else}
										<p class="text-sm italic text-gray-500">No songs yet from “Maybe” guests.</p>
									{/if}
								</div>
							</div>
						{/if}

						{#if question.publicResponses.some((r: any) => r.status === "not_attending")}
							{@const notTrackEntries = buildPlaylistEntries(
								question.publicResponses ?? [],
								"not_attending",
							)}
							<div class="panel-block tone-not overflow-hidden">
								<h3
									class="panel-block-header m-0 flex items-center gap-2.5 px-5 py-3.5 text-sm font-semibold"
								>
									<span
										class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold"
										style={`background-color: ${withAlpha(primaryColors[700], 0.8)}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.18)};`}
										>✗</span
									>
									Not Attending ({notTrackEntries.length}
									{notTrackEntries.length === 1 ? "song" : "songs"})
								</h3>
								<div class="panel-block-body px-5 py-4">
									{#if notTrackEntries.length > 0}
										<ul class="space-y-3">
											{#each previewList(notTrackEntries, expandedLists.has(`songs-${question.id}-not-attending`)) as entry, index (entry.key)}
												<li
													class="panel-list-item flex flex-col items-start gap-3 rounded-xl border p-3 transition-all hover:shadow-md sm:flex-row sm:items-center sm:gap-4 sm:p-4"
												>
													<div class="flex w-full items-center gap-3 sm:w-auto sm:gap-4">
														<span
															class="index-badge w-6 flex-shrink-0 text-center text-xs font-bold sm:w-8 sm:text-sm"
															style="color: {primaryColors[700]};">{index + 1}</span
														>
														{#if entry.track.image}
															<img
																src={entry.track.image}
																alt={entry.track.album
																	? `${entry.track.album} artwork`
																	: `${entry.track.name} artwork`}
																class="h-12 w-12 flex-shrink-0 rounded-lg object-cover shadow-sm sm:h-14 sm:w-14"
																loading="lazy"
															/>
														{/if}
														<div class="min-w-0 flex-1 space-y-0.5">
															<p class="truncate text-sm font-semibold text-dark-900">
																{#if entry.track.spotifyUrl}
																	<a
																		href={entry.track.spotifyUrl}
																		target="_blank"
																		rel="noreferrer"
																		class="hover:underline"
																	>
																		{entry.track.name}
																	</a>
																{:else}
																	{entry.track.name}
																{/if}
															</p>
															<p class="truncate text-xs text-dark-600">{entry.track.artists}</p>
															{#if entry.track.album}
																<p class="truncate text-xs text-dark-500">{entry.track.album}</p>
															{/if}
														</div>
													</div>
													<div class="flex flex-shrink-0 items-center gap-2 sm:ml-auto">
														<span
															class="contributor-chip inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-xs font-semibold"
															style="background-color: {primaryColors[100]}; color: {primaryColors[800]};"
														>
															<span aria-hidden="true">👤</span>
															<span class="hidden sm:inline">{entry.contributor}</span>
															<span class="sm:hidden">{entry.contributor.split(" ")[0]}</span>
														</span>
														<span
															class="song-note flex-shrink-0 text-lg sm:text-xl"
															style="color: {primaryColors[700]};"
															aria-hidden="true">♪</span
														>
													</div>
												</li>
											{/each}
										</ul>
										{@render showAll(
											`songs-${question.id}-not-attending`,
											notTrackEntries.length,
											"mt-3",
										)}
									{:else}
										<p class="text-sm italic text-gray-500">
											No songs yet from guests marked “Not Attending”.
										</p>
									{/if}
								</div>
							</div>
						{/if}
					</div>
				{:else}
					<!-- Non-Spotify Question (Text/Radio/Checkbox) -->
					<div class="flex flex-col gap-4">
						{#if question.publicResponses.some((r: any) => r.status === "attending")}
							{@const attendingResponses = question.publicResponses.filter(
								(r: any) => r.status === "attending",
							)}
							<div class="panel-block tone-attending overflow-hidden">
								<h3
									class="panel-block-header m-0 flex items-center gap-2.5 px-5 py-3.5 text-sm font-semibold"
								>
									<span
										class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold"
										style={`background-color: ${primaryColors[700]}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.28)};`}
										>✓</span
									>
									Attending ({attendingResponses.length})
								</h3>
								<div class="panel-block-body px-5 py-4">
									<ul class="space-y-2">
										{#each attendingResponses as response}
											<li class="panel-list-item flex items-start gap-3 rounded-xl border p-3">
												<div class="min-w-0 flex-1">
													<p class="mb-1 text-sm font-semibold text-dark-900">{response.name}</p>
													<p class="whitespace-pre-wrap break-words text-sm text-dark-700">
														{response.value}
													</p>
												</div>
											</li>
										{/each}
									</ul>
								</div>
							</div>
						{/if}

						{#if question.publicResponses.some((r: any) => r.status === "maybe")}
							{@const maybeResponses = question.publicResponses.filter(
								(r: any) => r.status === "maybe",
							)}
							<div class="panel-block tone-maybe overflow-hidden">
								<h3
									class="panel-block-header m-0 flex items-center gap-2.5 px-5 py-3.5 text-sm font-semibold"
								>
									<span
										class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold"
										style={`background-color: ${secondaryColors[700]}; color: white; box-shadow: 0 2px 8px ${withAlpha(secondaryColors[600], 0.25)};`}
										>?</span
									>
									Maybe ({maybeResponses.length})
								</h3>
								<div class="panel-block-body px-5 py-4">
									<ul class="space-y-2">
										{#each maybeResponses as response}
											<li class="panel-list-item flex items-start gap-3 rounded-xl border p-3">
												<div class="min-w-0 flex-1">
													<p class="mb-1 text-sm font-semibold text-dark-900">{response.name}</p>
													<p class="whitespace-pre-wrap break-words text-sm text-dark-700">
														{response.value}
													</p>
												</div>
											</li>
										{/each}
									</ul>
								</div>
							</div>
						{/if}

						{#if question.publicResponses.some((r: any) => r.status === "not_attending")}
							{@const notAttendingResponses = question.publicResponses.filter(
								(r: any) => r.status === "not_attending",
							)}
							<div class="panel-block tone-not overflow-hidden">
								<h3
									class="panel-block-header m-0 flex items-center gap-2.5 px-5 py-3.5 text-sm font-semibold"
								>
									<span
										class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold"
										style={`background-color: ${withAlpha(primaryColors[700], 0.8)}; color: white; box-shadow: 0 2px 8px ${withAlpha(primaryColors[600], 0.18)};`}
										>✗</span
									>
									Not Attending ({notAttendingResponses.length})
								</h3>
								<div class="panel-block-body px-5 py-4">
									<ul class="space-y-2">
										{#each notAttendingResponses as response}
											<li class="panel-list-item flex items-start gap-3 rounded-xl border p-3">
												<div class="min-w-0 flex-1">
													<p class="mb-1 text-sm font-semibold text-dark-900">{response.name}</p>
													<p class="whitespace-pre-wrap break-words text-sm text-dark-700">
														{response.value}
													</p>
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

<!-- Edit-link request modal -->
{#if showLinkModal}
	<div
		class="modal-backdrop"
		role="button"
		tabindex="0"
		aria-label="Close edit link dialog"
		onclick={(event) => event.target === event.currentTarget && closeLinkModal()}
		onkeydown={(event) => handleOverlayKeydown(event, closeLinkModal)}
	>
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="edit-link-title"
			tabindex="-1"
		>
			<div class="modal-header">
				<h3 id="edit-link-title">Edit my RSVP</h3>
				<button type="button" class="close-btn" aria-label="Close" onclick={closeLinkModal}
					>×</button
				>
			</div>
			{#if linkResult?.ok}
				<p class="mb-4" role="status" tabindex="-1" bind:this={linkStatus}>{linkResult.message}</p>
				<div class="modal-actions">
					<button type="button" class="btn-primary min-h-11" onclick={closeLinkModal}>Done</button>
				</div>
			{:else}
				<form
					method="POST"
					action="?/requestEditLink"
					use:enhance={() => {
						sendingLink = true;

						return async ({ result }) => {
							sendingLink = false;

							if (result.type === "success" || result.type === "failure") {
								linkResult = {
									ok: result.type === "success",
									message: String(result.data?.message ?? ""),
								};
							} else if (result.type === "error") {
								linkResult = {
									ok: false,
									message: "Something went wrong sending your link. Try again in a minute.",
								};
							}

							if (linkResult?.ok) {
								await tick();
								linkStatus?.focus();
							}
						};
					}}
				>
					{#if linkResult}
						<div class="error-banner mb-4" role="alert">{linkResult.message}</div>
					{/if}
					<label class="form-label">
						<span>The email you RSVP'd with</span>
						<input
							class="input-field"
							name="email"
							type="email"
							required
							autocomplete="email"
							placeholder="you@example.com"
							bind:this={linkEmailInput}
						/>
						<small class="text-sm text-gray-600"
							>We'll email you a link to edit your RSVP. It works for 1 hour.</small
						>
					</label>
					<div class="modal-actions">
						<button type="submit" class="btn-primary min-h-11" disabled={sendingLink}
							>{sendingLink ? "Sending…" : "Email me a link"}</button
						>
						<button type="button" class="btn-secondary min-h-11" onclick={closeLinkModal}
							>Cancel</button
						>
					</div>
				</form>
			{/if}
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
		onclick={(event) => event.target === event.currentTarget && closeEditModal()}
		onkeydown={(event) => handleOverlayKeydown(event, closeEditModal)}
	>
		<div
			class="modal large"
			role="dialog"
			aria-modal="true"
			aria-labelledby="edit-rsvp-title"
			tabindex="-1"
		>
			<div class="modal-header">
				<h3 id="edit-rsvp-title">Edit Your RSVP</h3>
				<button type="button" class="close-btn" aria-label="Close" onclick={closeEditModal}
					>×</button
				>
			</div>

			{#if (formType === "updateRsvp" || formType === "cancelRsvp") && message && !success}
				<div class="error-banner">{message}</div>
			{/if}

			<form
				method="POST"
				action="?/updateRsvp"
				class="rsvp-form"
				use:enhance={() => {
					return async ({ result, update }) => {
						const payload =
							result.type === "success" ? (result.data as RsvpMutation | undefined) : undefined;

						if (payload?.success) {
							// Update reactive state
							if (payload.rsvps) {
								rsvps = payload.rsvps;
							}

							if (payload.totalGuests !== undefined) {
								totalGuests = payload.totalGuests;
							}

							if (payload.questionResponseCounts) {
								questionResponseCounts = payload.questionResponseCounts;
							}

							// Close modal
							closeEditModal();
						}

						await update();

						if (result.type === "failure" && result.data?.potluck) {
							await invalidateAll();
						}
					};
				}}
			>
				<input type="hidden" name="expectedRsvpId" value={editingRsvp.id} />
				<label class="form-label">
					<span>Your name *</span>
					<input
						class="input-field"
						name="name"
						required
						maxlength="100"
						value={editingRsvp.name}
						bind:this={editNameInput}
						autocomplete="name"
					/>
				</label>

				<p class="form-label">
					<span>Email</span>
					<span class="text-dark-700">{editingRsvp.email}</span>
				</p>

				{#if editingStatus !== "not_attending"}
					<PlusOnesField bind:people={editingPeople} maxPlusOnes={event.maxPlusOnes} />
				{/if}

				<div class="status-section">
					<span class="status-label">Response status *</span>
					<div class="status-options">
						<label class="status-option">
							<input
								type="radio"
								name="status"
								value="attending"
								checked={editingStatus === "attending"}
								onchange={() => (editingStatus = "attending")}
								required
							/>
							<span>Attending</span>
						</label>
						<label class="status-option">
							<input
								type="radio"
								name="status"
								value="maybe"
								checked={editingStatus === "maybe"}
								onchange={() => (editingStatus = "maybe")}
							/>
							<span>Maybe</span>
						</label>
						<label class="status-option">
							<input
								type="radio"
								name="status"
								value="not_attending"
								checked={editingStatus === "not_attending"}
								onchange={() => {
									editingStatus = "not_attending";
									responses = {};
								}}
							/>
							<span>Not Attending</span>
						</label>
					</div>
				</div>

				{#if event.questions.length > 0 && (editingStatus === "attending" || editingStatus === "maybe")}
					<div class="questions-section">
						<div class="question-list">
							{#each event.questions as question}
								{#if question.type === "text"}
									<label class="form-label">
										<span>{question.label}{question.required ? " *" : ""}</span>
										{#if question.description}
											<small>{question.description}</small>
										{/if}
										<input
											class="input-field"
											name="response_{question.id}"
											type="text"
											value={responses[question.id] ?? ""}
											required={question.required}
											onchange={(e) => (responses[question.id] = e.currentTarget.value)}
										/>
									</label>
								{:else if question.type === "multiple_choice"}
									<fieldset>
										<legend>{question.label}{question.required ? " *" : ""}</legend>
										{#if question.description}
											<small>{question.description}</small>
										{/if}
										{#each question.options ?? [] as option}
											<label class="radio-option">
												<input
													type="radio"
													name="response_{question.id}"
													value={option}
													checked={responses[question.id] === option}
													required={question.required}
													onchange={(e) => (responses[question.id] = e.currentTarget.value)}
												/>
												<span>{option}</span>
											</label>
										{/each}
									</fieldset>
								{:else if question.type === "checkbox"}
									<fieldset>
										<legend>{question.label}{question.required ? " *" : ""}</legend>
										{#if question.description}
											<small>{question.description}</small>
										{/if}
										{#each question.options ?? [] as option}
											<label class="checkbox-option">
												<input
													type="checkbox"
													name="response_{question.id}"
													value={option}
													checked={responses[question.id]?.includes(option)}
													onchange={(e) => {
														const currentVals =
															responses[question.id]?.split(",").filter(Boolean) ?? [];

														if (e.currentTarget.checked) {
															responses[question.id] = [...currentVals, option].join(",");
														} else {
															responses[question.id] = currentVals
																.filter((v) => v !== option)
																.join(",");
														}
													}}
												/>
												<span>{option}</span>
											</label>
										{/each}
									</fieldset>
								{:else if question.type === "slots"}
									<label class="form-label">
										<span>{question.label}{question.required ? " *" : ""}</span>
										{#if question.description}
											<small class="text-sm text-gray-600">{question.description}</small>
										{/if}
										<input
											class="input-field"
											name="response_{question.id}"
											type="text"
											value={responses[question.id] ?? ""}
											required={question.required}
											placeholder="What are you bringing?"
											onchange={(e) => (responses[question.id] = e.currentTarget.value)}
										/>
										{#if question.quantity}
											<small class="text-sm text-gray-600"
												>{question.responseCount} of {question.quantity} slots filled</small
											>
										{/if}
									</label>
								{:else if question.type === "potluck" && potluckViews[question.id]}
									<PotluckField
										questionId={question.id}
										label={question.label}
										required={question.required}
										view={potluckViews[question.id]}
										value={responses[question.id] ?? ""}
										ownAnswer={editingRsvp.status === "not_attending"
											? null
											: parsePotluckAnswer(editingRsvp.responses?.[question.id])}
										offeredOverride={offeredAfterRejection("updateRsvp", question.id)}
										onchange={(raw) => (responses[question.id] = raw)}
									/>
								{:else if question.type === "spotify_playlist"}
									<div class="form-label">
										<span>{question.label}{question.required ? " *" : ""}</span>
										{#if question.description}
											<small class="text-sm text-gray-600">{question.description}</small>
										{/if}
										{#if question.songsPerUser}
											<small class="mb-2 block text-sm text-gray-600">
												Up to {question.songsPerUser} song{question.songsPerUser === 1 ? "" : "s"}.
											</small>
										{:else}
											<small class="mb-2 block text-sm text-gray-600">Add songs you love.</small>
										{/if}
										<SpotifySongSelector
											name="response_{question.id}"
											required={question.required}
											value={responses[question.id] ?? ""}
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

			<form
				method="POST"
				action="?/cancelRsvp"
				class="cancel-form"
				use:enhance={() => {
					return async ({ result, update }) => {
						showCancelConfirm = false;

						const payload =
							result.type === "success" ? (result.data as RsvpMutation | undefined) : undefined;

						if (payload?.success) {
							// Update reactive state
							rsvpCount = payload.rsvpCount ?? rsvpCount - 1;
							totalGuests = payload.totalGuests ?? totalGuests - 1;

							if (payload.rsvps) {
								rsvps = payload.rsvps;
							}

							if (payload.questionResponseCounts) {
								questionResponseCounts = payload.questionResponseCounts;
							}

							// Close modal
							closeEditModal();
						}

						await update();
					};
				}}
			>
				<input type="hidden" name="expectedRsvpId" value={editingRsvp.id} />
				{#if showCancelConfirm}
					<div class="flex justify-center gap-2">
						<button type="submit" class="btn-danger">Yes, Cancel RSVP</button>
						<button type="button" class="btn-secondary" onclick={() => (showCancelConfirm = false)}
							>Nevermind</button
						>
					</div>
				{:else}
					<button type="button" class="btn-danger" onclick={() => (showCancelConfirm = true)}
						>Cancel RSVP</button
					>
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
		onclick={(event) => event.target === event.currentTarget && closeRsvpModal()}
		onkeydown={(event) => handleOverlayKeydown(event, closeRsvpModal)}
	>
		<div
			class="modal large"
			role="dialog"
			aria-modal="true"
			aria-labelledby="create-rsvp-title"
			tabindex="-1"
		>
			<div class="modal-header">
				<h3 id="create-rsvp-title">RSVP to {event.title}</h3>
				<button type="button" class="close-btn" aria-label="Close" onclick={closeRsvpModal}
					>×</button
				>
			</div>

			{#if formType === "rsvp" && message && !form?.alreadyRegistered}
				<div class="error-banner">{message}</div>
			{/if}

			<form
				method="POST"
				action="?/rsvp"
				class="rsvp-form"
				use:enhance={() => {
					submittingRsvp = true;

					return async ({ result, update }) => {
						submittingRsvp = false;

						const payload =
							result.type === "success" ? (result.data as RsvpMutation | undefined) : undefined;

						if (payload?.success) {
							// Update reactive state
							rsvpCount = payload.rsvpCount ?? rsvpCount + 1;
							totalGuests = payload.totalGuests ?? totalGuests + 1;

							if (payload.rsvps) {
								rsvps = payload.rsvps;
							}

							if (payload.questionResponseCounts) {
								questionResponseCounts = payload.questionResponseCounts;
							}

							showRsvpModal = false;
							responses = {};
							newPeople = [];
						}

						if (result.type === "failure" && result.data?.alreadyRegistered) {
							showRsvpModal = false;
						}

						const failedGuestNames =
							result.type === "failure" && result.data?.type === "rsvp"
								? submittedGuestNames(result.data)
								: null;

						if (failedGuestNames) {
							newPeople = failedGuestNames.map((name) => newPerson(name));
						}

						await update();

						if (result.type === "failure" && result.data?.potluck) {
							await invalidateAll();
						}
					};
				}}
			>
				<label class="form-label">
					<span>Your name *</span>
					<input
						class="input-field"
						name="name"
						required
						maxlength="100"
						value={values.name ?? ""}
						autocomplete="name"
						placeholder="Your full name"
					/>
					{#if errors.name}
						<small class="text-sm text-red-600">{errors.name[0]}</small>
					{/if}
				</label>

				<label class="form-label">
					<span>Email *</span>
					<input
						class="input-field"
						type="email"
						name="email"
						required
						value={values.email ?? ""}
						autocomplete="email"
						placeholder="you@example.com"
					/>
					<small class="text-sm text-gray-600">We'll email your edit link.</small>
					{#if errors.email}
						<small class="text-sm text-red-600">{errors.email[0]}</small>
					{/if}
				</label>

				{#if newRsvpStatus !== "not_attending"}
					<PlusOnesField
						bind:people={newPeople}
						error={errors.guestNames?.[0]}
						maxPlusOnes={event.maxPlusOnes}
					/>
				{/if}

				<div class="status-section">
					<span class="status-label">Response status *</span>
					<div class="status-options">
						<label class="status-option">
							<input
								type="radio"
								name="status"
								value="attending"
								checked={newRsvpStatus === "attending"}
								onchange={() => (newRsvpStatus = "attending")}
								required
							/>
							<span>Attending</span>
						</label>
						<label class="status-option">
							<input
								type="radio"
								name="status"
								value="maybe"
								checked={newRsvpStatus === "maybe"}
								onchange={() => (newRsvpStatus = "maybe")}
							/>
							<span>Maybe</span>
						</label>
						<label class="status-option">
							<input
								type="radio"
								name="status"
								value="not_attending"
								checked={newRsvpStatus === "not_attending"}
								onchange={() => {
									newRsvpStatus = "not_attending";
									responses = {};
								}}
							/>
							<span>Not Attending</span>
						</label>
					</div>
				</div>

				{#if event.questions.length > 0 && (newRsvpStatus === "attending" || newRsvpStatus === "maybe")}
					<div class="questions-section">
						<div class="question-list">
							{#each event.questions as question}
								{@const isFull = Boolean(
									question.quantity && question.responseCount >= question.quantity,
								)}
								{@const isRequired = question.required && !isFull}

								{#if question.type === "text"}
									<label class="form-label" class:disabled={isFull}>
										<span>
											{question.label}{isRequired ? " *" : ""}
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
											value={responses[question.id] ?? ""}
											required={isRequired}
											disabled={isFull}
											placeholder={isFull ? "This question is at capacity" : ""}
											onchange={(e) => (responses[question.id] = e.currentTarget.value)}
										/>
									</label>
								{:else if question.type === "multiple_choice"}
									<fieldset class:disabled={isFull}>
										<legend class="form-label">
											{question.label}{isRequired ? " *" : ""}
											{#if isFull}
												<span class="badge-danger ml-2">Full</span>
											{/if}
										</legend>
										{#if question.description}
											<small class="text-sm text-gray-600">{question.description}</small>
										{/if}
										{#each question.options ?? [] as option}
											<label class="radio-option">
												<input
													type="radio"
													name="response_{question.id}"
													value={option}
													checked={responses[question.id] === option}
													required={isRequired}
													disabled={isFull}
													onchange={(e) => (responses[question.id] = e.currentTarget.value)}
												/>
												<span>{option}</span>
											</label>
										{/each}
									</fieldset>
								{:else if question.type === "checkbox"}
									<fieldset class:disabled={isFull}>
										<legend class="form-label">
											{question.label}{isRequired ? " *" : ""}
											{#if isFull}
												<span class="badge-danger ml-2">Full</span>
											{/if}
										</legend>
										{#if question.description}
											<small class="text-sm text-gray-600">{question.description}</small>
										{/if}
										{#each question.options ?? [] as option}
											<label class="checkbox-option">
												<input
													type="checkbox"
													name="response_{question.id}"
													value={option}
													checked={responses[question.id]?.includes(option)}
													disabled={isFull}
													onchange={(e) => {
														const currentVals =
															responses[question.id]?.split(",").filter(Boolean) ?? [];

														if (e.currentTarget.checked) {
															responses[question.id] = [...currentVals, option].join(",");
														} else {
															responses[question.id] = currentVals
																.filter((v) => v !== option)
																.join(",");
														}
													}}
												/>
												<span>{option}</span>
											</label>
										{/each}
									</fieldset>
								{:else if question.type === "slots"}
									<label class="form-label" class:disabled={isFull}>
										<span>
											{question.label}{isRequired ? " *" : ""}
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
											value={responses[question.id] ?? ""}
											required={isRequired}
											disabled={isFull}
											placeholder={isFull ? "All slots are taken" : "What are you bringing?"}
											onchange={(e) => (responses[question.id] = e.currentTarget.value)}
										/>
										{#if question.quantity}
											<small
												class="text-sm"
												class:text-red-600={isFull}
												class:text-gray-600={!isFull}
												>{question.responseCount} of {question.quantity} slots filled</small
											>
										{/if}
									</label>
								{:else if question.type === "potluck" && potluckViews[question.id]}
									<PotluckField
										questionId={question.id}
										label={question.label}
										required={question.required}
										view={potluckViews[question.id]}
										value={responses[question.id] ?? ""}
										offeredOverride={offeredAfterRejection("rsvp", question.id)}
										onchange={(raw) => (responses[question.id] = raw)}
									/>
								{:else if question.type === "spotify_playlist"}
									<div class="form-label">
										<span>
											{question.label}{isRequired ? " *" : ""}
											{#if isFull}
												<span class="badge-danger ml-2">Full</span>
											{/if}
										</span>
										{#if question.description}
											<small class="text-sm text-gray-600">{question.description}</small>
										{/if}
										{#if question.songsPerUser}
											<small class="mb-2 block text-sm text-gray-600">
												Up to {question.songsPerUser} song{question.songsPerUser === 1 ? "" : "s"}.
											</small>
										{:else}
											<small class="mb-2 block text-sm text-gray-600">Add songs you love.</small>
										{/if}
										<SpotifySongSelector
											name="response_{question.id}"
											required={isRequired}
											value={responses[question.id] ?? ""}
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
					<button type="submit" class="btn-primary w-full" disabled={submittingRsvp}
						>{submittingRsvp ? "Saving…" : "Confirm RSVP"}</button
					>
					<button type="button" class="btn-secondary w-full" onclick={closeRsvpModal}>Cancel</button
					>
				</div>
			</form>
		</div>
	</div>
{/if}

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
		background-image:
			var(--event-background-overlay-dark, none), var(--event-background-image, none);
	}

	.event-card {
		background: var(--event-card-surface, rgba(255, 255, 255, 0.95));
		box-shadow: 0 4px 24px -4px rgba(0, 0, 0, 0.08);
		border: 1px solid var(--event-surface-border, rgba(124, 93, 250, 0.1));
		border-radius: 24px;
		transition:
			transform 0.2s ease,
			box-shadow 0.2s ease;
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
	.event-section span,
	.panel-block-body p,
	.panel-block-body span,
	.panel-list-item p,
	.panel-list-item span {
		color: var(--event-text-secondary, #3c2f68);
	}

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
		box-shadow:
			0 16px 32px -12px rgba(6, 7, 18, 0.55),
			0 0 0 1px var(--event-surface-glow-dark, rgba(124, 93, 250, 0.16));
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
		box-shadow:
			0 8px 32px -4px rgba(0, 0, 0, 0.12),
			0 0 0 1px var(--event-primary-600-alpha);
	}

	:global(.dark) .event-card:hover {
		box-shadow:
			0 8px 32px -4px rgba(0, 0, 0, 0.6),
			0 0 0 1px var(--event-primary-600-alpha);
	}

	details.panel {
		background: var(--event-panel-surface);
		border: 1px solid var(--event-surface-border);
		border-radius: 20px;
		/* Performance: Contain layout to isolate reflows */
		contain: layout style;
		box-shadow: 0 2px 12px -4px var(--event-panel-shadow);
		overflow: hidden;
		transition:
			background-color 0.2s ease,
			border-color 0.2s ease,
			box-shadow 0.2s ease;
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
		transition:
			background-color 0.2s ease,
			color 0.2s ease,
			border-color 0.2s ease;
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
		transition:
			background-color 0.2s ease,
			border-color 0.2s ease,
			box-shadow 0.2s ease;
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
		transition:
			background-color 0.2s ease,
			color 0.2s ease,
			border-color 0.2s ease;
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

	:global(.dark) .index-badge,
	:global(.dark) .song-note {
		color: var(--event-primary-100) !important;
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
