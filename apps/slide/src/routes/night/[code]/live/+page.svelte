<script lang="ts">
	import { enhance } from "$app/forms";
	import { invalidateAll, goto } from "$app/navigation";
	import ParticleBackground from "$lib/components/ParticleBackground.svelte";
	import { onMount, onDestroy, untrack } from "svelte";

	const { data } = $props();
	let {
		event,
		orderedGroups,
		isHost,
		votingSession,
		votingSessions,
		participants,
		currentUser,
		currentPresentationVotes,
		totalPotentialVoters,
		existingVotes,
		userGroupIds,
		topPresentations,
		categoryWinners,
		fullLeaderboard,
	} = $derived(data);

	// Simple background shapes for CSS animations
	interface BackgroundShape {
		id: number;
		type: "circle" | "square" | "triangle";
		color: string;
		size: number;
		left: number;
		top: number;
		delay: number;
		duration: number;
	}

	let backgroundShapes = $state<BackgroundShape[]>([]);

	function initBackgroundShapes() {
		const shapes: BackgroundShape[] = [];
		const colors = [
			"rgb(168 85 247 / 0.15)",
			"rgb(236 72 153 / 0.15)",
			"rgb(147 197 253 / 0.15)",
			"rgb(129 140 248 / 0.15)",
			"rgb(216 180 254 / 0.15)",
		];
		const types: ("circle" | "square" | "triangle")[] = [
			"circle",
			"circle",
			"square",
			"square",
			"triangle",
			"circle",
			"square",
			"triangle",
		];
		const sizes = [60, 68, 56, 64, 60, 72, 58, 66];

		for (let i = 0; i < 8; i++) {
			shapes.push({
				id: i,
				type: types[i],
				color: colors[i % colors.length],
				size: sizes[i],
				left: (i * 15) % 100,
				top: (i * 20) % 100,
				delay: i * 1.5,
				duration: 15 + i * 3,
			});
		}

		backgroundShapes = shapes;
	}

	// Sync local reveal step with server
	let winnersRevealStep = $derived(event.winnersRevealStep || 0);
	let showLeaderboard = $state(false);

	// Determine which podium places exist
	const existingPlaces = $derived(() => {
		const places = [];
		if (topPresentations.third.length > 0) places.push({ step: 1, label: "🥉 Reveal 3rd Place" });
		if (topPresentations.second.length > 0) places.push({ step: 2, label: "🥈 Reveal 2nd Place" });
		if (topPresentations.first.length > 0) places.push({ step: 3, label: "🥇 Reveal 1st Place" });
		places.push({ step: 4, label: "🎉 Show Confetti!" });
		return places;
	});

	// Get the next reveal step
	const nextRevealStep = $derived(() => {
		const places = existingPlaces();
		const currentIndex = places.findIndex((p) => p.step > winnersRevealStep);
		return currentIndex >= 0 ? places[currentIndex] : null;
	});

	// Check for ties in top 3
	const hasTies = $derived(() => {
		return (
			topPresentations.first.length > 1 ||
			topPresentations.second.length > 1 ||
			topPresentations.third.length > 1
		);
	});

	// Check if any revealed position has a tie
	const hasRevealedTie = $derived(() => {
		// Third place revealed and has tie
		if (winnersRevealStep >= 1 && topPresentations.third.length > 1) return true;
		// Second place revealed and has tie
		if (winnersRevealStep >= 2 && topPresentations.second.length > 1) return true;
		// First place revealed and has tie
		if (winnersRevealStep >= 3 && topPresentations.first.length > 1) return true;
		return false;
	});

	let qrCodeUrl = $state("");
	let showJoinModal = $state(false);
	let displayName = $state("");
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	let ratings = $state<Record<string, number>>({});
	let hoveredStars = $state<Record<string, number>>({});
	let hasVotedForCurrent = $state(false);
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let presentationListElement = $state<HTMLDivElement | null>(null);
	let sortableInstance: Sortable | null = null;
	let showParticipants = $state(false);
	let isTransitioning = $state(false);
	let isInitialized = $state(false);
	let localOrderedGroups = $state<any[]>([]);
	let lastPresentationId = $state<string | null>(null);
	let savingRating = $state(false);
	let accountDropdownOpen = $state(false);
	let showWinnersScreen = $state(false);
	let confettiPieces = $state<
		Array<{ id: number; left: number; delay: number; duration: number; color: string }>
	>([]);
	let confettiCounter = $state(0);
	let lastConfettiCount = $state(0);

	// Timer state
	let timerDisplay = $state("00:00");
	let timerExpired = $state(false);
	let timerPaused = $state(false);
	let showTimerModal = $state(false);
	let timerMinutes = $state(5);

	// Detect presentation changes for smooth transitions (for participants)
	$effect(() => {
		const currentId = event.currentPresentationId;

		// Skip on initial load
		if (lastPresentationId === null && isInitialized) {
			lastPresentationId = currentId;
			loadRatingsForPresentation();
			return;
		}

		// Detect change
		if (isInitialized && currentId !== lastPresentationId) {
			// Trigger transition
			isTransitioning = true;
			setTimeout(() => {
				lastPresentationId = currentId;
				loadRatingsForPresentation();
				isTransitioning = false;
			}, 400);
		}
	});

	// Load existing ratings for the current presentation
	function loadRatingsForPresentation() {
		untrack(() => {
			const currentId = event.currentPresentationId;
			if (currentId && existingVotes[currentId]) {
				ratings = { ...existingVotes[currentId] };
			} else {
				ratings = {};
			}

			// Check if all categories have been rated
			hasVotedForCurrent = event.categories.every((cat: any) => ratings[cat.id] > 0);
		});
	}

	// Get voting URL
	const votingUrl = $derived(() => {
		if (typeof window === "undefined") return "";
		return `${window.location.origin}/night/${event.joinCode}/live`;
	});

	// Current presentation
	const currentPresentation = $derived(() => {
		if (!event.currentPresentationId) return null;
		return localOrderedGroups.find((g: any) => g.id === event.currentPresentationId) || null;
	});

	// Check if user can vote (and is not voting on their own presentation)
	const canVote = $derived(!!votingSession || !!currentUser);

	// Check if the current presentation is the user's own presentation
	const isOwnPresentation = $derived(() => {
		const pres = currentPresentation();
		if (!pres || !userGroupIds) return false;
		return userGroupIds.includes(pres.id);
	});

	// Total participants count (logged in + temp voters)
	const totalParticipants = $derived(() => {
		return participants.length + votingSessions.length;
	});

	// Current presentation index
	const currentPresentationIndex = $derived(() => {
		const pres = currentPresentation();
		if (!pres) return -1;
		return localOrderedGroups.findIndex((g: any) => g.id === pres.id);
	});

	onMount(async () => {
		// Initialize local ordered groups from server data
		if (orderedGroups && Array.isArray(orderedGroups)) {
			localOrderedGroups = [...orderedGroups];
		}

		// Initialize background shapes
		initBackgroundShapes();

		// Lazy load QR code library only for hosts (reduces initial bundle size)
		if (isHost) {
			try {
				const QRCode = (await import("qrcode")).default;
				const url = votingUrl();
				if (url) {
					qrCodeUrl = await QRCode.toDataURL(url, {
						width: 300,
						margin: 2,
						color: {
							dark: "#8b5cf6", // Purple color matching the theme
							light: "#ffffff",
						},
						errorCorrectionLevel: "M",
					});
				}
			} catch (err) {
				console.error("Failed to generate QR code:", err);
			}
		}

		// Lazy load Sortable library only for hosts (reduces initial bundle size)
		if (isHost && presentationListElement) {
			try {
				const Sortable = (await import("sortablejs")).default;
				sortableInstance = new Sortable(presentationListElement, {
					animation: 150,
					handle: ".drag-handle",
					onEnd: handleReorder,
				});
			} catch (e) {
				console.error("Failed to initialize sortable:", e);
			}
		}

		// Mark as initialized and set initial presentation ID
		lastPresentationId = event.currentPresentationId;

		// Load existing ratings if on a presentation
		loadRatingsForPresentation();

		isInitialized = true;

		// Adaptive polling: Use longer intervals on mobile devices to save battery and reduce network load
		// Detect mobile: check for touch support and smaller screen width
		const isMobile =
			("ontouchstart" in window || navigator.maxTouchPoints > 0) && window.innerWidth < 768;
		const pollDelay = isMobile ? 3000 : 1000; // 3 seconds on mobile, 1 second on desktop

		// Poll for updates
		pollInterval = setInterval(() => {
			invalidateAll().catch(() => {
				// Silently ignore errors (e.g., if page is navigating away)
			});
		}, pollDelay);
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
		if (sortableInstance) sortableInstance.destroy();
	});

	// Poll for confetti triggers - reactive to event.confettiCount changes
	$effect(() => {
		if (!isInitialized) return;

		// Check for confetti triggers by watching the counter
		const currentCount = event.confettiCount || 0;

		// Only shoot if the count has increased (skip initial load)
		if (lastConfettiCount > 0 && currentCount > lastConfettiCount) {
			const countDiff = currentCount - lastConfettiCount;
			console.log("New confetti triggers detected! Count:", currentCount, "Diff:", countDiff);

			// Trigger up to 5 confetti bursts with delays
			const burstsToTrigger = Math.min(countDiff, 5);
			const delayBetweenBursts = 200; // 200ms between each burst

			for (let i = 0; i < burstsToTrigger; i++) {
				setTimeout(() => {
					shootConfetti();
				}, i * delayBetweenBursts);
			}
		}

		// Update last known count
		lastConfettiCount = currentCount;
	});

	// Auto-show join modal if user is not authenticated during active presentation
	$effect(() => {
		if (!isInitialized) return;

		// If there's an active presentation and user is not logged in and doesn't have a session, show join modal
		if (event.currentPresentationId && !currentUser && !votingSession && !showJoinModal) {
			showJoinModal = true;
		}
	});

	// Timer synchronization effect - all clients calculate from same server timestamp
	// This ensures everyone sees the exact same countdown no matter when they join
	$effect(() => {
		if (!event) return;

		const evt = event as any;
		const timerStartedAt = evt.timerStartedAt;
		const timerDuration = evt.timerDuration;
		const timerPausedAt = evt.timerPausedAt;
		const timerPausedRemaining = evt.timerPausedRemaining;

		// Clear any existing timer interval
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}

		// No timer running
		if (!timerStartedAt) {
			timerDisplay = "00:00";
			timerExpired = false;
			timerPaused = false;
			return;
		}

		// Timer is paused
		if (timerPausedAt) {
			timerPaused = true;
			const remaining = timerPausedRemaining || 0;
			const minutes = Math.floor(remaining / 60);
			const seconds = remaining % 60;
			timerDisplay = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
			timerExpired = remaining <= 0;
			return;
		}

		// Timer is running - calculate remaining time based on server's start timestamp
		// All clients use the same reference point (timerStartedAt) so they stay in sync
		timerPaused = false;

		function updateTimer() {
			if (!timerStartedAt || !timerDuration) return;

			// Calculate elapsed time from server's start time to now
			// This is synchronized across all clients since they all use the same timerStartedAt
			const startTime = new Date(timerStartedAt).getTime();
			const now = Date.now();
			const elapsed = Math.floor((now - startTime) / 1000);

			// Round to nearest second to eliminate sub-second differences between browsers
			const remaining = Math.max(0, timerDuration - elapsed);

			const minutes = Math.floor(remaining / 60);
			const seconds = remaining % 60;
			timerDisplay = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
			timerExpired = remaining <= 0;
		}

		// Update immediately to show current state
		updateTimer();

		// Update every second for smooth countdown
		// Server data refreshes every 2s via polling to re-sync if needed
		timerInterval = setInterval(updateTimer, 1000);
	});

	onDestroy(() => {
		// Clear all intervals immediately
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}

		// Destroy sortable instance
		if (sortableInstance) {
			try {
				sortableInstance.destroy();
			} catch (e) {
				// Ignore errors during cleanup
			}
			sortableInstance = null;
		}
	});

	function handleReorder() {
		if (!presentationListElement) return;

		try {
			const items = Array.from(presentationListElement.children);
			const newOrder = items
				.map((item) => item.getAttribute("data-group-id"))
				.filter(Boolean) as string[];

			if (newOrder.length === 0) return;

			// Update local state immediately (optimistic update)
			const reorderedGroups = newOrder
				.map((id) => localOrderedGroups.find((g: any) => g?.id === id))
				.filter(Boolean);

			if (reorderedGroups.length > 0) {
				localOrderedGroups = reorderedGroups;
			}

			// Save to server in background
			const formData = new FormData();
			formData.append("order", JSON.stringify(newOrder));
			fetch("?/reorderPresentations", {
				method: "POST",
				body: formData,
			}).catch((err) => {
				console.error("Failed to save presentation order:", err);
				// Optionally: revert to server state on error
			});
		} catch (e) {
			console.error("Error reordering presentations:", e);
		}
	}

	async function startPresentation(groupId: string) {
		// Stop any running timer when switching presentations
		await stopTimer();

		// Start fade out
		isTransitioning = true;
		hasVotedForCurrent = false;

		// Reset ratings
		const newRatings: Record<string, number> = {};
		event.categories.forEach((cat: any) => {
			newRatings[cat.id] = 0;
		});
		ratings = newRatings;

		// Wait for fade out to complete before updating
		setTimeout(() => {
			const formData = new FormData();
			formData.append("groupId", groupId);
			fetch("?/setCurrentPresentation", {
				method: "POST",
				body: formData,
			})
				.then(() => {
					return invalidateAll();
				})
				.then(() => {
					// Wait a bit before fading in
					return setTimeout(() => {
						isTransitioning = false;
					}, 100);
				});
		}, 300);
	}

	async function nextPresentation() {
		const idx = currentPresentationIndex();

		// If we're on the last presentation, show winners
		if (idx >= 0 && idx === localOrderedGroups.length - 1) {
			await stopTimer();

			// Show winners without confirmation
			const formData = new FormData();
			await fetch("?/showWinners", {
				method: "POST",
				body: formData,
			});

			await invalidateAll();
			showWinnersScreen = true;
		} else if (idx >= 0 && idx < localOrderedGroups.length - 1) {
			await startPresentation(localOrderedGroups[idx + 1].id);
		}
	}

	async function previousPresentation() {
		const idx = currentPresentationIndex();
		if (idx > 0) {
			await startPresentation(localOrderedGroups[idx - 1].id);
		}
	}

	async function endPresentation() {
		await stopTimer();
		// Start fade out
		isTransitioning = true;

		// Wait for fade out to complete before updating
		setTimeout(() => {
			const formData = new FormData();
			formData.append("groupId", "");
			fetch("?/setCurrentPresentation", {
				method: "POST",
				body: formData,
			})
				.then(() => {
					return invalidateAll();
				})
				.then(() => {
					// Wait a bit before fading in
					return setTimeout(() => {
						isTransitioning = false;
					}, 100);
				});
		}, 300);
	}

	function removeParticipant(userId: string) {
		if (!confirm("Remove this participant from the event?")) return;

		const formData = new FormData();
		formData.append("userId", userId);
		fetch("?/removeParticipant", {
			method: "POST",
			body: formData,
		}).then(() => invalidateAll());
	}

	function removeVotingSession(sessionId: string) {
		if (!confirm("Remove this voter from the event?")) return;

		const formData = new FormData();
		formData.append("sessionId", sessionId);
		fetch("?/removeVotingSession", {
			method: "POST",
			body: formData,
		}).then(() => invalidateAll());
	}

	async function setRating(categoryId: string, stars: number) {
		// Prevent voting on own presentation
		if (isOwnPresentation()) {
			alert("You cannot vote on your own presentation!");
			return;
		}

		ratings = { ...ratings, [categoryId]: stars };

		// Auto-save the rating
		const currentPres = currentPresentation();
		if (!currentPres) return;

		savingRating = true;
		const formData = new FormData();
		formData.append("groupId", currentPres.id);
		formData.append("categoryId", categoryId);
		formData.append("stars", stars.toString());

		try {
			const response = await fetch(
				`?/autoSaveRating${votingSession ? `&session=${votingSession.sessionCode}` : ""}`,
				{
					method: "POST",
					body: formData,
				},
			);

			const result = await response.json();
			if (result?.error) {
				alert(result.error);
				// Clear the rating on error
				const { [categoryId]: _, ...rest } = ratings;
				ratings = rest;
				return;
			}

			// Check if all categories are now rated
			hasVotedForCurrent = event.categories.every((cat: any) => ratings[cat.id] > 0);

			// Refresh to update vote count
			await invalidateAll();
		} finally {
			savingRating = false;
		}
	}

	function setHoveredStars(categoryId: string, stars: number) {
		hoveredStars = { ...hoveredStars, [categoryId]: stars };
	}

	function clearHoveredStars(categoryId: string) {
		const { [categoryId]: _, ...rest } = hoveredStars;
		hoveredStars = rest;
	}

	async function resetAllVotes() {
		if (!confirm("Are you sure you want to reset ALL votes for this event? This cannot be undone!"))
			return;

		const formData = new FormData();
		await fetch("?/resetVotes", {
			method: "POST",
			body: formData,
		});

		await invalidateAll();
	}

	async function handleLogout() {
		const response = await fetch("/auth/logout", { method: "POST" });
		if (response.ok) {
			goto("/");
		}
	}

	// Timer control functions
	async function startTimer() {
		const formData = new FormData();
		formData.append("minutes", timerMinutes.toString());

		showTimerModal = false;

		// Send to server and wait for response
		await fetch("?/startTimer", {
			method: "POST",
			body: formData,
		});

		// Refresh data to get the server's timestamp
		await invalidateAll();
	}

	async function pauseTimer() {
		const formData = new FormData();
		await fetch("?/pauseTimer", {
			method: "POST",
			body: formData,
		});
		await invalidateAll();
	}

	async function resumeTimer() {
		const formData = new FormData();
		await fetch("?/resumeTimer", {
			method: "POST",
			body: formData,
		});
		await invalidateAll();
	}

	async function stopTimer() {
		// Optimistically clear timer for immediate feedback (stopping should be instant)
		const evt = event as any;
		evt.timerStartedAt = null;
		evt.timerDuration = null;
		evt.timerPausedAt = null;
		evt.timerPausedRemaining = null;

		const formData = new FormData();
		await fetch("?/stopTimer", {
			method: "POST",
			body: formData,
		});
		await invalidateAll();
	}

	// Close dropdown when clicking outside
	function handleClickOutside(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest(".account-dropdown")) {
			accountDropdownOpen = false;
		}
	}

	async function showWinners() {
		if (!confirm("Show the winners screen? This will end the event.")) return;

		const formData = new FormData();
		await fetch("?/showWinners", {
			method: "POST",
			body: formData,
		});

		await invalidateAll();
		showWinnersScreen = true;
	}

	async function revealNextWinner() {
		const next = nextRevealStep();
		if (!next) return;

		const formData = new FormData();
		formData.append("step", String(next.step));

		await fetch("?/revealWinner", {
			method: "POST",
			body: formData,
		});

		await invalidateAll();
	}

	async function revealPreviousWinner() {
		if (winnersRevealStep <= 0) {
			// Go back to presentation mode
			showWinnersScreen = false;

			// Reset event status back to active
			await fetch("?/backToPresentations", {
				method: "POST",
				body: new FormData(),
			});

			// Reset reveal step to 0
			const formData = new FormData();
			formData.append("step", "0");
			await fetch("?/revealWinner", { method: "POST", body: formData });

			await invalidateAll();
			return;
		}

		// Find the previous reveal step
		const places = existingPlaces();
		const currentIndex = places.findIndex((p) => p.step === winnersRevealStep);
		const prevPlace = currentIndex > 0 ? places[currentIndex - 1] : null;

		const prevStep = prevPlace ? prevPlace.step - 1 : winnersRevealStep - 1;
		const formData = new FormData();
		formData.append("step", String(Math.max(0, prevStep)));

		await fetch("?/revealWinner", {
			method: "POST",
			body: formData,
		});

		await invalidateAll();
	}

	function shootConfetti() {
		const colors = [
			"#FFD700",
			"#FF6B6B",
			"#4ECDC4",
			"#45B7D1",
			"#FFA07A",
			"#98D8C8",
			"#F7DC6F",
			"#BB8FCE",
		];
		const newPieces = Array.from({ length: 50 }, (_, i) => ({
			id: confettiCounter + i,
			left: Math.random() * 100,
			delay: Math.random() * 0.3,
			duration: 3 + Math.random() * 2,
			color: colors[Math.floor(Math.random() * colors.length)],
		}));

		confettiPieces = [...confettiPieces, ...newPieces];
		confettiCounter += 50;

		// Clean up old confetti after animation
		setTimeout(() => {
			confettiPieces = confettiPieces.filter((p) => p.id >= confettiCounter - 50);
		}, 6000);
	}

	async function triggerConfettiForEveryone() {
		console.log("Triggering confetti for everyone...");

		// Shoot locally first for instant feedback
		shootConfetti();

		// Trigger for everyone else via server
		try {
			const response = await fetch("?/triggerConfetti", {
				method: "POST",
				body: new FormData(),
			});

			if (!response.ok) {
				console.error("Failed to trigger confetti:", response.status, response.statusText);
				const text = await response.text();
				console.error("Response body:", text);
			} else {
				console.log("Confetti triggered successfully!");
			}
		} catch (error) {
			console.error("Error triggering confetti:", error);
		}

		// Force immediate reload so polling picks up the new timestamp
		await invalidateAll();
	}
</script>

<svelte:window onclick={handleClickOutside} />

<ParticleBackground />

<!-- Confetti Layer -->
{#if confettiPieces.length > 0}
	<div class="pointer-events-none fixed inset-0 z-50 overflow-hidden">
		{#each confettiPieces as piece (piece.id)}
			<div
				class="absolute h-3 w-3 animate-confetti"
				style="
					left: {piece.left}%;
					top: -20px;
					background-color: {piece.color};
					animation-delay: {piece.delay}s;
					animation-duration: {piece.duration}s;
					transform: rotate({Math.random() * 360}deg);
				"
			></div>
		{/each}
	</div>
{/if}

<div
	class="animate-gradient relative min-h-screen overflow-hidden bg-gradient-to-br from-purple-400/60 via-pink-400/55 to-blue-400/60"
>
	<!-- Background Shapes -->
	<div class="pointer-events-none fixed inset-0 z-0 overflow-hidden">
		{#each backgroundShapes as shape (shape.id)}
			{#if shape.type === "circle"}
				<div
					class="animate-float-random absolute rounded-full"
					style="
						width: {shape.size}px;
						height: {shape.size}px;
						left: {shape.left}%;
						top: {shape.top}%;
						background: {shape.color};
						animation-delay: {shape.delay}s;
						animation-duration: {shape.duration}s;
					"
				></div>
			{:else if shape.type === "square"}
				<div
					class="animate-float-random absolute rounded-[2rem]"
					style="
						width: {shape.size}px;
						height: {shape.size}px;
						left: {shape.left}%;
						top: {shape.top}%;
						background: {shape.color};
						animation-delay: {shape.delay}s;
						animation-duration: {shape.duration}s;
					"
				></div>
			{:else if shape.type === "triangle"}
				<svg
					class="animate-float-random absolute"
					viewBox="0 0 100 100"
					style="
						width: {shape.size}px;
						height: {shape.size}px;
						left: {shape.left}%;
						top: {shape.top}%;
						animation-delay: {shape.delay}s;
						animation-duration: {shape.duration}s;
					"
				>
					<path d="M 50 10 L 90 90 L 10 90 Z" fill={shape.color} rx="8" />
				</svg>
			{/if}
		{/each}
	</div>

	<!-- Star Particles (removed) -->

	{#if !isInitialized}
		<!-- Loading Screen -->
		<div class="flex min-h-screen items-center justify-center">
			<div class="text-center">
				<div
					class="mx-auto mb-4 h-16 w-16 animate-spin rounded-full border-4 border-white/20 border-t-white"
				></div>
				<p class="text-xl font-semibold text-white">Loading...</p>
			</div>
		</div>
	{:else if showWinnersScreen || event.status === "completed"}
		<!-- WINNERS SCREEN -->
		<div
			class="relative flex min-h-screen flex-col items-center justify-center overflow-hidden p-8"
		>
			<!-- Animated Background -->
			<div class="absolute inset-0 overflow-hidden">
				{#each Array(50) as _, i}
					<div
						class="absolute h-2 w-2 animate-float rounded-full bg-white/20"
						style="left: {Math.random() * 100}%; top: {Math.random() *
							100}%; animation-delay: {Math.random() * 5}s; animation-duration: {5 +
							Math.random() * 5}s;"
					></div>
				{/each}
			</div>

			<!-- Title -->
			<div class="animate-fade-in-down relative z-10 mb-16 text-center">
				<h1
					class="animate-pulse-slow mb-4 whitespace-nowrap bg-gradient-to-r from-yellow-400 via-pink-500 to-purple-600 bg-clip-text text-5xl font-black text-transparent sm:text-7xl md:text-9xl"
				>
					🏆 WINNERS 🏆
				</h1>
				{#if hasRevealedTie()}
					<p class="mt-2 animate-pulse text-lg font-bold text-yellow-300 md:text-xl">
						⚡ We have a tie! ⚡
					</p>
				{/if}
			</div>

			<!-- Podium -->
			<div class="relative z-10 mb-12 w-full px-2 pt-16 sm:px-4 sm:pt-20">
				<div
					class="mx-auto flex items-end justify-center gap-1 sm:gap-2 md:gap-4 lg:gap-6 xl:gap-8"
				>
					<!-- Third Place (#3) -->
					{#each topPresentations.third as presentation, idx}
						<div
							class="flex w-24 flex-col items-center sm:w-32 md:w-48 lg:min-w-[200px] lg:max-w-[280px] lg:flex-1"
							class:animate-slide-up-bounce={winnersRevealStep >= 1}
							style="
								opacity: {winnersRevealStep >= 1 ? '1' : '0'};
								visibility: {winnersRevealStep >= 1 ? 'visible' : 'hidden'};
								animation-delay: {idx * 0.15}s;
								transition: opacity 0.3s ease-in-out;
							"
						>
							<div
								class="mb-2 w-full transform rounded-lg bg-gradient-to-br from-orange-400 to-orange-600 px-2 py-2 text-center shadow-2xl transition-all hover:scale-105 sm:mb-3 sm:rounded-xl sm:px-4 sm:py-3 md:mb-4 md:rounded-2xl md:px-6 md:py-4 lg:mb-6 lg:rounded-3xl lg:px-8 lg:py-6"
							>
								<div
									class="mb-1 text-3xl sm:mb-2 sm:text-5xl md:mb-3 md:text-6xl lg:text-7xl xl:text-8xl"
								>
									{presentation.group.emoji || "🎯"}
								</div>
								<h3
									class="mb-1 line-clamp-2 text-xs font-bold text-white sm:mb-2 sm:text-lg md:text-xl lg:text-2xl xl:text-4xl"
								>
									{presentation.group.name}
								</h3>
								<p
									class="mb-1 line-clamp-2 hidden text-xs text-orange-100 sm:mb-2 sm:text-sm md:mb-3 md:block md:text-base lg:text-lg"
								>
									{presentation.group.members?.map((m: any) => m.user.name).join(", ")}
								</p>
								<div
									class="rounded-md bg-white/50 px-2 py-1 sm:rounded-lg sm:px-3 sm:py-2 md:rounded-xl md:px-4 md:py-3 lg:px-6"
								>
									<div
										class="text-lg font-black text-orange-900 sm:text-2xl md:text-3xl lg:text-4xl xl:text-5xl"
									>
										★ {presentation.totalScore}
									</div>
									<div class="text-xs text-orange-800 sm:text-sm md:text-base lg:text-lg">
										{presentation.voteCount} votes
									</div>
								</div>
							</div>
							<div
								class="md:border-6 flex h-16 w-full items-center justify-center rounded-t-lg border-2 border-orange-700 bg-gradient-to-t from-orange-600 to-orange-400 shadow-2xl sm:h-24 sm:rounded-t-xl sm:border-4 md:h-32 md:rounded-t-2xl lg:h-40 xl:h-48"
							>
								<span
									class="text-3xl font-black text-orange-900 sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl"
									>3</span
								>
							</div>
						</div>
					{/each}

					<!-- Second Place (#2) -->
					{#each topPresentations.second as presentation, idx}
						<div
							class="flex w-28 flex-col items-center sm:w-36 md:w-52 lg:min-w-[220px] lg:max-w-[300px] lg:flex-1"
							class:animate-slide-up-bounce={winnersRevealStep >= 2}
							style="
								opacity: {winnersRevealStep >= 2 ? '1' : '0'};
								visibility: {winnersRevealStep >= 2 ? 'visible' : 'hidden'};
								animation-delay: {0.2 + idx * 0.15}s;
								transition: opacity 0.3s ease-in-out;
							"
						>
							<div
								class="mb-3 w-full transform rounded-xl bg-gradient-to-br from-gray-300 to-gray-500 px-4 py-3 text-center shadow-2xl transition-all hover:scale-105 sm:mb-4 sm:rounded-2xl sm:px-6 sm:py-4 md:mb-6 md:rounded-3xl md:px-8 md:py-6"
							>
								<div class="mb-1 text-2xl sm:text-3xl md:text-4xl lg:text-6xl">
									{presentation.group.emoji || "�"}
								</div>
								<h3 class="mb-2 text-lg font-bold text-gray-900 sm:text-xl md:text-2xl lg:text-4xl">
									{presentation.group.name}
								</h3>
								<p
									class="mb-2 hidden text-sm text-gray-700 sm:mb-3 sm:text-base md:block md:text-lg"
								>
									{presentation.group.members?.map((m: any) => m.user.name).join(", ")}
								</p>
								<div
									class="rounded-md bg-white/50 px-2 py-1 sm:rounded-lg sm:px-3 sm:py-2 md:rounded-xl md:px-4 md:py-3 lg:px-6"
								>
									<div
										class="text-lg font-black text-gray-900 sm:text-2xl md:text-3xl lg:text-4xl xl:text-5xl"
									>
										★ {presentation.totalScore}
									</div>
									<div class="text-xs text-gray-700 sm:text-sm md:text-base lg:text-lg">
										{presentation.voteCount} votes
									</div>
								</div>
							</div>
							<div
								class="md:border-6 flex h-20 w-full items-center justify-center rounded-t-lg border-2 border-gray-500 bg-gradient-to-t from-gray-400 to-gray-300 shadow-2xl sm:h-32 sm:rounded-t-xl sm:border-4 md:h-40 md:rounded-t-2xl lg:h-48 xl:h-56"
							>
								<span
									class="text-3xl font-black text-gray-800 sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl"
									>2</span
								>
							</div>
						</div>
					{/each}

					<!-- First Place (#1) -->
					{#each topPresentations.first as presentation, idx}
						<div
							class="relative flex w-32 flex-col items-center sm:w-40 md:w-56 lg:min-w-[240px] lg:max-w-[320px] lg:flex-1"
							class:animate-slide-up-bounce-large={winnersRevealStep >= 3}
							style="
								opacity: {winnersRevealStep >= 3 ? '1' : '0'};
								visibility: {winnersRevealStep >= 3 ? 'visible' : 'hidden'};
								animation-delay: {idx * 0.15}s;
								transition: opacity 0.3s ease-in-out;
							"
						>
							<div
								class="sm:border-6 relative mb-3 w-full transform rounded-xl border-4 border-yellow-600 bg-gradient-to-br from-yellow-300 via-yellow-400 to-yellow-500 px-6 py-4 text-center shadow-2xl transition-all hover:scale-105 sm:mb-4 sm:rounded-2xl sm:px-8 sm:py-6 md:mb-6 md:rounded-3xl md:px-10 md:py-8"
							>
								{#if winnersRevealStep >= 4}
									<div
										class="animate-spin-slow absolute -left-6 -top-8 text-5xl sm:-left-8 sm:-top-10 sm:text-6xl md:-left-10 md:-top-12 md:text-7xl lg:text-8xl"
									>
										👑
									</div>
									<div
										class="animate-spin-slow absolute -right-6 -top-8 text-5xl sm:-right-8 sm:-top-10 sm:text-6xl md:-right-10 md:-top-12 md:text-7xl lg:text-8xl"
										style="animation-delay: 0.5s;"
									>
										👑
									</div>
								{/if}
								<div class="mb-1 text-3xl sm:mb-2 sm:text-4xl md:text-6xl lg:text-8xl">
									{presentation.group.emoji || "�"}
								</div>
								<h3
									class="mb-1 line-clamp-1 text-sm font-black text-gray-900 sm:text-lg md:text-2xl lg:text-3xl"
								>
									{presentation.group.name}
								</h3>
								<p
									class="mb-1 line-clamp-1 hidden text-xs font-semibold text-gray-800 sm:mb-2 sm:text-sm md:block md:text-base"
								>
									{presentation.group.members?.map((m: any) => m.user.name).join(", ")}
								</p>
								<div
									class="rounded-md bg-white/80 px-2 py-2 sm:rounded-xl sm:px-4 sm:py-3 md:rounded-xl md:px-6 md:py-4 lg:px-8"
								>
									<div
										class="text-xl font-black text-yellow-600 sm:text-3xl md:text-4xl lg:text-5xl xl:text-6xl"
									>
										★ {presentation.totalScore}
									</div>
									<div
										class="text-xs font-semibold text-gray-800 sm:text-base md:text-lg lg:text-xl"
									>
										{presentation.voteCount} votes
									</div>
								</div>

								<!-- Star Explosion when first place appears -->
								{#if winnersRevealStep >= 3}
									<div
										class="pointer-events-none absolute inset-0 flex items-center justify-center overflow-visible"
									>
										{#each Array(50) as _, i}
											<div
												class="animate-star-burst absolute"
												style="
													font-size: {1 + Math.random() * 2}rem;
													--burst-x: {Math.cos((i * 137.5 * Math.PI) / 180) * (100 + Math.random() * 100)}px;
													--burst-y: {Math.sin((i * 137.5 * Math.PI) / 180) * (100 + Math.random() * 100)}px;
													--rotation: {Math.random() * 720 - 360}deg;
													animation-duration: {0.8 + Math.random() * 0.6}s;
												"
											>
												⭐
											</div>
										{/each}
									</div>
								{/if}
							</div>
							<div
								class="md:border-6 flex h-24 w-full items-center justify-center rounded-t-lg border-2 border-yellow-600 bg-gradient-to-t from-yellow-500 to-yellow-300 shadow-2xl sm:h-40 sm:rounded-t-xl sm:border-4 md:h-48 md:rounded-t-2xl lg:h-56 xl:h-64"
							>
								<span
									class="text-4xl font-black text-yellow-800 sm:text-6xl md:text-7xl lg:text-8xl xl:text-9xl"
									>1</span
								>
							</div>
						</div>
					{/each}
				</div>
			</div>

			<!-- Confetti Animation -->
			{#if winnersRevealStep >= 4}
				<div class="pointer-events-none fixed inset-0 z-50">
					{#each Array(100) as _, i}
						<div
							class="absolute h-3 w-3 animate-confetti"
							style="
								left: {Math.random() * 100}%;
								top: -10%;
								background: {['#FFD700', '#FF69B4', '#00CED1', '#FF6347', '#32CD32'][i % 5]};
								animation-delay: {Math.random() * 3}s;
								animation-duration: {3 + Math.random() * 2}s;
							"
						></div>
					{/each}
				</div>
			{/if}

			<!-- Category Winners (Show after confetti) -->
			{#if winnersRevealStep >= 4 && categoryWinners.length > 0}
				<div
					class="animate-fade-in-down relative z-10 mb-12 w-full max-w-6xl px-4"
					style="animation-delay: 2s;"
				>
					<h2 class="mb-8 text-center text-3xl font-black text-white sm:text-4xl md:text-5xl">
						🏅 Category Champions
					</h2>
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
						{#each categoryWinners as catWinner}
							<div
								class="glass-bright rounded-2xl border-2 border-purple-300/40 p-4 shadow-xl transition-all hover:scale-105 sm:p-6"
							>
								<h3 class="mb-3 text-lg font-bold text-yellow-400 sm:text-xl">
									{catWinner.category.name}
									{#if catWinner.isTie}
										<span class="ml-2 text-xs text-white/70">(TIE)</span>
									{/if}
								</h3>

								{#each catWinner.winners as winner}
									<div class="mb-3 flex items-center gap-3 last:mb-0">
										<div class="text-2xl sm:text-3xl">{winner.group.emoji || "🎯"}</div>
										<div class="flex-1">
											<p class="text-sm font-semibold text-white sm:text-base">
												{winner.group.name}
											</p>
											<p class="text-xs text-white/60">
												{winner.group.members?.map((m: any) => m.user.name).join(", ")}
											</p>
										</div>
									</div>
								{/each}

								<div class="mt-2 rounded-lg bg-white/20 px-3 py-2 text-center">
									<div class="text-xl font-black text-yellow-300 sm:text-2xl">
										★ {catWinner.winners[0].score.toFixed(2)}
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- Full Leaderboard (Collapsible) -->
				<div
					class="animate-fade-in-down relative z-10 mb-12 w-full max-w-4xl px-4"
					style="animation-delay: 3s;"
				>
					<button
						onclick={() => (showLeaderboard = !showLeaderboard)}
						class="glass-bright mb-4 w-full rounded-2xl border-2 border-white/20 p-6 shadow-xl transition-all hover:bg-white/20"
					>
						<div class="flex items-center justify-between">
							<h2 class="text-2xl font-black text-white sm:text-3xl">📊 Full Leaderboard</h2>
							<span class="text-2xl text-white">{showLeaderboard ? "▼" : "▶"}</span>
						</div>
					</button>

					{#if showLeaderboard}
						<div
							class="glass-bright animate-slide-up-bounce overflow-hidden rounded-2xl border-2 border-white/20 shadow-xl"
						>
							<div class="overflow-x-auto">
								<table class="w-full">
									<thead class="bg-white/20">
										<tr>
											<th class="px-4 py-3 text-left font-bold text-white">#</th>
											<th class="px-4 py-3 text-left font-bold text-white">Team</th>
											<th class="hidden px-4 py-3 text-center font-bold text-white sm:table-cell"
												>Members</th
											>
											<th class="px-4 py-3 text-center font-bold text-white">Avg Stars</th>
											<th class="px-4 py-3 text-center font-bold text-white">Votes</th>
										</tr>
									</thead>
									<tbody>
										{#each fullLeaderboard as item, idx}
											<tr class="border-t border-white/10 transition-colors hover:bg-white/10">
												<td class="px-4 py-3 text-lg font-bold text-white">{idx + 1}</td>
												<td class="px-4 py-3">
													<div class="flex items-center gap-2">
														<span class="text-2xl sm:text-3xl">{item.group.emoji || "🎯"}</span>
														<span class="text-sm font-semibold text-white sm:text-base"
															>{item.group.name}</span
														>
													</div>
												</td>
												<td
													class="hidden px-4 py-3 text-center text-xs text-white/70 sm:table-cell sm:text-sm"
												>
													{item.group.members?.map((m: any) => m.user.name).join(", ")}
												</td>
												<td class="px-4 py-3 text-center">
													<div class="flex items-center justify-center gap-1">
														{#each Array(5) as _, i}
															<svg
																class="h-4 w-4 sm:h-5 sm:w-5"
																fill={i < Math.round(item.averageScore) ? "#FFD700" : "none"}
																stroke="#FFD700"
																stroke-width="2"
																viewBox="0 0 24 24"
															>
																<path
																	d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
																/>
															</svg>
														{/each}
														<span class="ml-2 text-sm font-bold text-yellow-300 sm:text-base"
															>{item.averageScore.toFixed(1)}</span
														>
													</div>
												</td>
												<td class="px-4 py-3 text-center text-sm text-white sm:text-base"
													>{item.voteCount}</td
												>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Confetti Button (for everyone) -->
			<div class="relative z-10 mt-8 flex justify-center">
				<button
					onclick={triggerConfettiForEveryone}
					class="transform rounded-full border-4 border-white/50 bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500 px-10 py-5 text-xl font-black text-white shadow-2xl transition hover:scale-110 hover:from-pink-600 hover:via-purple-600 hover:to-indigo-600 active:scale-95"
				>
					🎉 Confetti Cannon! 🎉
				</button>
			</div>

			<!-- Actions -->
			{#if isHost}
				<div class="relative z-10 mt-12 flex flex-wrap justify-center gap-4">
					<button
						onclick={revealPreviousWinner}
						class="rounded-xl border-2 border-white/30 bg-white/20 px-8 py-4 text-lg font-bold text-white backdrop-blur-xl transition hover:bg-white/30"
					>
						← {winnersRevealStep === 0 ? "Back to Presentations" : "Previous"}
					</button>
					{#if nextRevealStep()}
						<button
							onclick={revealNextWinner}
							class="animate-pulse-slow rounded-xl border-4 border-yellow-300 bg-gradient-to-r from-yellow-400 via-yellow-500 to-yellow-600 px-12 py-5 text-2xl font-black text-gray-900 shadow-2xl transition hover:from-yellow-500 hover:via-yellow-600 hover:to-yellow-700"
						>
							{nextRevealStep()?.label || "Next"}
						</button>
					{/if}
					<button
						onclick={async () => {
							showWinnersScreen = false;
							const formData = new FormData();
							formData.append("step", "0");
							await fetch("?/revealWinner", { method: "POST", body: formData });
							await invalidateAll();
						}}
						class="rounded-xl border-2 border-white/30 bg-white/20 px-8 py-4 text-lg font-bold text-white backdrop-blur-xl transition hover:bg-white/30"
					>
						Back to Lobby
					</button>
					<button
						onclick={() => goto("/dashboard")}
						class="rounded-xl bg-purple-600 px-8 py-4 text-lg font-bold text-white shadow-xl transition hover:bg-purple-700"
					>
						Dashboard
					</button>
				</div>
			{/if}
		</div>
	{:else if !currentPresentation()}
		<!-- LOBBY/STAGING SCREEN (before host starts) -->
		<div class="min-h-screen p-8 transition-opacity duration-500" class:opacity-0={isTransitioning}>
			<div class="mx-auto max-w-7xl">
				<!-- Header -->
				<div class="mb-8 text-center">
					<h1 class="mb-4 text-6xl font-bold text-white">{event.name}</h1>
					<div
						class="glass-bright inline-flex items-center gap-3 rounded-full border border-white/20 px-6 py-3"
					>
						<div class="h-3 w-3 animate-pulse rounded-full bg-green-400"></div>
						<span class="font-semibold text-white">Live Lobby</span>
					</div>
				</div>

				<div class="grid gap-6 lg:grid-cols-3">
					<!-- Left Column: QR Code & Link (Host) or Join (Non-host) -->
					<div class="space-y-6 lg:col-span-1">
						{#if isHost}
							<!-- Host: QR Code & Link -->
							<div class="glass-bright rounded-2xl border-2 border-purple-300/40 p-6 shadow-xl">
								<h2 class="mb-4 text-2xl font-bold text-white">📱 Join Link</h2>

								{#if qrCodeUrl}
									<div class="mb-4 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 p-1">
										<div class="rounded-xl bg-white p-4">
											<img
												src={qrCodeUrl}
												alt="Join QR Code"
												class="mx-auto w-full max-w-[240px]"
											/>
										</div>
									</div>
								{/if}

								<div class="mb-4 rounded-lg border border-white/10 bg-white/20 p-3">
									<p class="break-all text-center font-mono text-sm text-white">
										{votingUrl()}
									</p>
								</div>

								<p class="text-center text-sm text-white/70">
									Share this link or QR code with voters
								</p>
							</div>

							<!-- Participants List -->
							<div class="glass-bright rounded-2xl border-2 border-purple-300/40 p-6 shadow-xl">
								<div class="mb-4 flex items-center justify-between">
									<h2 class="text-xl font-bold text-white">
										👥 Participants ({totalParticipants()})
									</h2>
									<button
										onclick={() => (showParticipants = !showParticipants)}
										class="text-white/70 transition hover:text-white"
									>
										{showParticipants ? "▼" : "▶"}
									</button>
								</div>

								{#if showParticipants}
									<div class="max-h-96 space-y-2 overflow-y-auto">
										<!-- Logged in participants -->
										{#each participants as participant}
											<div class="flex items-center justify-between rounded-lg bg-white/5 p-3">
												<div>
													<p class="font-semibold text-white">{participant.user.name}</p>
													<p class="text-xs text-white/50">{participant.user.email}</p>
												</div>
												<button
													onclick={() => removeParticipant(participant.userId)}
													class="rounded bg-red-600/20 px-3 py-1 text-sm text-red-300 transition hover:bg-red-600 hover:text-white"
												>
													Remove
												</button>
											</div>
										{/each}

										<!-- Temp voters -->
										{#each votingSessions as session}
											<div class="flex items-center justify-between rounded-lg bg-white/5 p-3">
												<div class="flex flex-1 items-center gap-2">
													<div class="h-2 w-2 rounded-full bg-green-400"></div>
													<div>
														<p class="font-semibold text-white">{session.displayName}</p>
														<p class="text-xs text-white/50">Temporary Voter</p>
													</div>
												</div>
												<button
													onclick={() => removeVotingSession(session.id)}
													class="rounded bg-red-600/20 px-3 py-1 text-sm text-red-300 transition hover:bg-red-600 hover:text-white"
												>
													Remove
												</button>
											</div>
										{/each}
									</div>
								{/if}
							</div>

							<!-- Reset Votes Button -->
							<div class="glass-bright rounded-2xl border-2 border-purple-300/40 p-6 shadow-xl">
								<h2 class="mb-4 text-xl font-bold text-white">🔄 Vote Management</h2>
								<button
									onclick={resetAllVotes}
									class="w-full rounded-lg border border-red-600/50 bg-red-600/20 py-3 font-semibold text-red-300 transition hover:bg-red-600 hover:text-white"
								>
									Reset All Votes
								</button>
								<p class="mt-2 text-center text-xs text-white/50">
									This will delete all votes for this event
								</p>
							</div>
						{:else if !votingSession && !currentUser}
							<!-- Non-host: Join Button -->
							<div
								class="glass-bright-strong rounded-2xl border-2 border-purple-300/40 p-8 text-center shadow-xl"
							>
								<div class="mb-4 text-6xl">🎤</div>
								<h2 class="mb-4 text-2xl font-bold text-white">Join as Voter</h2>
								<p class="mb-6 text-white/70">Enter your name to participate in the voting</p>
								<button
									onclick={() => (showJoinModal = true)}
									class="w-full transform rounded-xl bg-purple-600 py-4 text-lg font-semibold text-white shadow-lg transition-all hover:scale-105 hover:bg-purple-700"
								>
									Join Now
								</button>
							</div>
						{:else}
							<!-- Joined: Waiting -->
							<div
								class="glass-bright-strong rounded-2xl border-2 border-purple-300/40 p-8 text-center shadow-xl"
							>
								<div class="relative mx-auto mb-6 h-20 w-20">
									<div
										class="absolute inset-0 animate-ping rounded-full bg-green-500 opacity-20"
									></div>
									<div
										class="absolute inset-0 flex items-center justify-center rounded-full bg-green-600"
									>
										<span class="text-3xl">✓</span>
									</div>
								</div>
								<h2 class="mb-2 text-2xl font-bold text-white">You're In!</h2>
								<p class="text-white/70">
									{#if votingSession}
										Joined as: <span class="font-semibold text-white"
											>{votingSession.displayName}</span
										>
									{:else}
										{currentUser?.name}
									{/if}
								</p>
								<p class="mt-4 text-sm text-white/50">Waiting for host to start...</p>
							</div>
						{/if}
					</div>

					<!-- Right Column: Presentation Order -->
					<div class="lg:col-span-2">
						<div class="glass-bright rounded-2xl border-2 border-purple-300/40 p-6 shadow-xl">
							<h2 class="mb-4 text-2xl font-bold text-white">
								📋 Presentation Order ({localOrderedGroups?.length || 0})
							</h2>

							{#if !localOrderedGroups || localOrderedGroups.length === 0}
								<div class="py-12 text-center">
									<p class="text-white/50">No presentations submitted yet</p>
								</div>
							{:else}
								<div bind:this={presentationListElement} class="space-y-3">
									{#each localOrderedGroups || [] as group, index (group.id)}
										<div
											data-group-id={group.id}
											class="flex items-center gap-4 rounded-xl bg-white/5 p-4 transition hover:bg-white/10"
										>
											{#if isHost}
												<button
													class="drag-handle cursor-grab text-white/50 transition hover:text-white active:cursor-grabbing"
													aria-label="Drag to reorder"
												>
													<svg class="h-6 w-6" fill="currentColor" viewBox="0 0 20 20">
														<path
															d="M7 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 2zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 14zm6-8a2 2 0 1 0-.001-4.001A2 2 0 0 0 13 6zm0 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 14z"
														></path>
													</svg>
												</button>
											{/if}

											<div class="flex-1">
												<div class="mb-2 flex items-center gap-3">
													<span class="text-2xl">{group.emoji || "📊"}</span>
													<div class="flex-1">
														<h3 class="text-xl font-bold text-white">{group.name}</h3>
														<p class="text-sm text-white/50">
															{group.members?.map((m: any) => m.user.name).join(", ") ||
																"No members"}
														</p>
													</div>
													<span class="text-3xl font-bold text-white/30">#{index + 1}</span>
												</div>
											</div>
										</div>
									{/each}
								</div>

								{#if isHost && localOrderedGroups && localOrderedGroups.length > 0}
									<div class="mt-6 space-y-3">
										<button
											onclick={() => startPresentation(localOrderedGroups[0].id)}
											class="w-full transform rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 py-4 text-xl font-bold text-white shadow-lg transition-all hover:scale-105 hover:from-green-700 hover:to-emerald-700"
										>
											🎬 Start First Presentation
										</button>
										<button
											onclick={showWinners}
											class="w-full transform rounded-xl bg-gradient-to-r from-yellow-500 to-orange-500 py-4 text-xl font-bold text-white shadow-lg transition-all hover:scale-105 hover:from-yellow-600 hover:to-orange-600"
										>
											🏆 Show Winners Screen
										</button>
									</div>
								{/if}
							{/if}
						</div>
					</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- ACTIVE PRESENTATION SCREEN -->
	{#if currentPresentation()}
		{@const pres = currentPresentation()}

		<div
			class="min-h-screen p-4 transition-opacity duration-500 md:p-8"
			class:opacity-0={isTransitioning}
		>
			<!-- Top Navigation Bar -->
			<nav class="fixed left-0 right-0 top-0 z-50 border-b border-gray-800 bg-theater-dark">
				<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
					<div class="flex h-16 items-center justify-between gap-4">
						<!-- Logo/Brand -->
						<button
							onclick={() => goto("/dashboard")}
							class="flex flex-shrink-0 items-center gap-2 text-xl font-bold text-white transition hover:text-purple-400"
						>
							<span class="text-2xl">🎤</span>
							<span class="hidden sm:inline">SlideNight</span>
							<span class="sm:hidden">SN</span>
						</button>

						<!-- Center: Progress Bar with Live indicator -->
						<div class="flex max-w-2xl flex-1 items-center gap-3">
							<div class="flex flex-shrink-0 items-center gap-2">
								<div class="h-2 w-2 animate-pulse rounded-full bg-red-500"></div>
								<span class="hidden text-sm text-white/70 md:inline">Live</span>
							</div>

							{#if canVote && currentPresentation()}
								<div
									class="flex flex-shrink-0 items-center gap-2 rounded-lg px-2 py-1 {hasVotedForCurrent
										? 'border border-green-500/50 bg-green-500/20'
										: 'border border-yellow-500/50 bg-yellow-500/20'}"
								>
									{#if hasVotedForCurrent}
										<svg class="h-4 w-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
											<path
												fill-rule="evenodd"
												d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
												clip-rule="evenodd"
											/>
										</svg>
										<span class="hidden text-xs font-semibold text-green-400 sm:inline">Voted</span>
									{:else}
										<svg class="h-4 w-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
											<path
												fill-rule="evenodd"
												d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
												clip-rule="evenodd"
											/>
										</svg>
										<span class="hidden text-xs font-semibold text-yellow-400 sm:inline"
											>Vote Now</span
										>
									{/if}
								</div>
							{/if}

							<div class="flex-shrink-0 text-sm text-white/70">
								{currentPresentationVotes || 0}/{totalPotentialVoters || 0}
							</div>
							<div
								class="h-6 flex-1 overflow-hidden rounded-full border border-gray-600 bg-gray-700"
							>
								<div
									class="flex h-full items-center justify-end bg-gradient-to-r from-yellow-400 via-yellow-500 to-yellow-600 pr-2 transition-all duration-500 ease-out"
									style="width: {totalPotentialVoters > 0
										? (currentPresentationVotes / totalPotentialVoters) * 100
										: 0}%"
								>
									{#if currentPresentationVotes > 0 && totalPotentialVoters > 0}
										<span class="text-xs font-bold text-gray-900">
											{Math.round((currentPresentationVotes / totalPotentialVoters) * 100)}%
										</span>
									{/if}
								</div>
							</div>
						</div>

						<!-- Right Side - Account Dropdown -->
						{#if currentUser}
							<div class="account-dropdown relative flex-shrink-0">
								<button
									onclick={() => (accountDropdownOpen = !accountDropdownOpen)}
									class="flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-gray-800"
								>
									<div
										class="flex h-8 w-8 items-center justify-center rounded-full bg-theater-purple font-semibold text-white"
									>
										{currentUser.name?.charAt(0).toUpperCase()}
									</div>
									<span class="hidden text-white sm:inline">{currentUser.name}</span>
									<svg
										class="h-4 w-4 text-gray-400 transition-transform {accountDropdownOpen
											? 'rotate-180'
											: ''}"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M19 9l-7 7-7-7"
										></path>
									</svg>
								</button>

								{#if accountDropdownOpen}
									<div
										class="absolute right-0 mt-2 w-56 rounded-lg border border-gray-800 bg-theater-dark py-2 shadow-xl"
									>
										<!-- User Info -->
										<div class="border-b border-gray-800 px-4 py-3">
											<p class="text-sm font-semibold text-white">{currentUser.name}</p>
											<p class="truncate text-xs text-gray-400">{currentUser.email}</p>
										</div>

										<!-- Menu Items -->
										<button
											onclick={() => {
												accountDropdownOpen = false;
												goto("/dashboard");
											}}
											class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 transition hover:bg-gray-800 hover:text-white"
										>
											<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
												></path>
											</svg>
											Dashboard
										</button>

										<button
											onclick={() => {
												accountDropdownOpen = false;
												goto("/settings");
											}}
											class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 transition hover:bg-gray-800 hover:text-white"
										>
											<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
												></path>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
												></path>
											</svg>
											Settings
										</button>

										<div class="my-2 border-t border-gray-800"></div>

										<button
											onclick={handleLogout}
											class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-red-400 transition hover:bg-gray-800 hover:text-red-300"
										>
											<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
												></path>
											</svg>
											Log Out
										</button>
									</div>
								{/if}
							</div>
						{:else if votingSession}
							<div class="flex flex-shrink-0 items-center gap-2 px-3 py-2">
								<div
									class="flex h-8 w-8 items-center justify-center rounded-full bg-green-600 font-semibold text-white"
								>
									{votingSession.displayName?.charAt(0).toUpperCase()}
								</div>
								<span class="hidden text-white sm:inline">{votingSession.displayName}</span>
							</div>
						{:else}
							<div class="flex-shrink-0 px-3 py-2">
								<div
									class="flex h-8 w-8 items-center justify-center rounded-full bg-gray-700 text-xl"
								>
									🎤
								</div>
							</div>
						{/if}
					</div>
				</div>
			</nav>

			<div class="mx-auto max-w-6xl pt-20">
				<!-- Presentation Header -->
				<div class="glass-bright mb-6 rounded-2xl border border-white/20 p-6 shadow-xl">
					<div class="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
						<div class="flex items-center gap-4">
							<span class="text-5xl">{pres?.emoji || "📊"}</span>
							<div>
								<h2 class="mb-1 text-3xl font-bold text-white">
									{pres?.name}
								</h2>
								<p class="text-white/70">
									{pres?.members?.map((m: any) => m.user.name).join(", ") || "Unknown"}
								</p>
							</div>
						</div>

						<!-- Timer Display -->
						<div class="flex flex-col items-center gap-3">
							{#if timerDisplay !== "00:00"}
								<div class="text-center">
									<div
										class="mb-1 font-mono text-5xl font-bold text-white {timerExpired
											? 'animate-pulse text-red-500'
											: timerDisplay.startsWith('00:') && parseInt(timerDisplay.split(':')[1]) < 30
												? 'text-yellow-400'
												: 'text-white'}"
									>
										{timerDisplay}
									</div>
									<p class="text-sm text-white/70">
										{timerPaused
											? "⏸️ Paused"
											: timerExpired
												? "⏰ Time's Up!"
												: "⏱️ Time Remaining"}
									</p>
								</div>
							{/if}

							{#if isHost}
								<div class="flex gap-2">
									{#if timerDisplay === "00:00"}
										<button
											onclick={() => (showTimerModal = true)}
											class="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-700"
										>
											<span>⏱️</span>
											<span>Start Timer</span>
										</button>
									{:else if timerPaused}
										<button
											onclick={resumeTimer}
											class="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-blue-700"
										>
											▶️ Resume
										</button>
										<button
											onclick={stopTimer}
											class="rounded-lg bg-red-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-700"
										>
											⏹️ Stop
										</button>
									{:else}
										<button
											onclick={pauseTimer}
											class="rounded-lg bg-yellow-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-yellow-700"
										>
											⏸️ Pause
										</button>
										<button
											onclick={stopTimer}
											class="rounded-lg bg-red-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-700"
										>
											⏹️ Stop
										</button>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				</div>

				<!-- Voting Section -->
				{#if canVote}
					<div class="glass-bright mb-6 rounded-2xl border border-white/20 p-8 shadow-xl">
						{#if isOwnPresentation()}
							<!-- Show message when it's user's own presentation -->
							<div class="py-12 text-center">
								<div class="mb-4 text-6xl">🚫</div>
								<h3 class="mb-4 text-2xl font-bold text-white">This is Your Presentation</h3>
								<p class="text-lg text-white/70">You cannot vote on your own presentation.</p>
								<p class="mt-2 text-sm text-white/50">
									Please wait for other presentations to rate.
								</p>
							</div>
						{:else}
							<!-- Normal voting interface -->
							<div class="mb-6 flex items-center justify-between">
								<h3 class="text-2xl font-bold text-white">⭐ Rate This Presentation</h3>
								{#if savingRating}
									<div class="flex items-center gap-2 text-sm text-white/70">
										<div
											class="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white"
										></div>
										<span>Saving...</span>
									</div>
								{/if}
							</div>

							<div class="space-y-6">
								{#each event.categories as category}
									<div class="rounded-xl bg-white/5 p-6">
										<h4 class="mb-4 text-xl font-semibold text-white">
											{category.name}
											{#if ratings[category.id]}
												<span class="ml-2 text-yellow-400">✓</span>
											{/if}
										</h4>
										{#if category.description}
											<p class="mb-4 text-sm text-white/60">{category.description}</p>
										{/if}

										<div class="flex justify-center gap-2">
											{#each [1, 2, 3, 4, 5] as star}
												<button
													type="button"
													onclick={() => setRating(category.id, star)}
													onmouseenter={() => setHoveredStars(category.id, star)}
													onmouseleave={() => clearHoveredStars(category.id)}
													class="transform transition-all hover:scale-125"
													aria-label="Rate {star} stars"
												>
													<svg
														class="h-12 w-12 transition-all duration-200"
														fill={(hoveredStars[category.id] || ratings[category.id] || 0) >= star
															? "#FFD700"
															: "none"}
														stroke={(hoveredStars[category.id] || ratings[category.id] || 0) >= star
															? "#FFD700"
															: "#FFFFFF"}
														stroke-width="2"
														viewBox="0 0 24 24"
													>
														<path
															d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
														/>
													</svg>
												</button>
											{/each}
										</div>
									</div>
								{/each}
							</div>

							{#if hasVotedForCurrent}
								<div
									class="mt-6 rounded-xl border border-green-500/50 bg-green-500/20 p-4 text-center"
								>
									<p class="flex items-center justify-center gap-2 font-semibold text-green-400">
										<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
											<path
												fill-rule="evenodd"
												d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
												clip-rule="evenodd"
											/>
										</svg>
										All categories rated! Your vote is saved.
									</p>
								</div>
							{/if}
						{/if}
					</div>
				{/if}

				<!-- Host Controls -->
				{#if isHost}
					<div class="glass-bright rounded-2xl border-2 border-purple-300/40 p-6 shadow-xl">
						<h3 class="mb-4 text-xl font-bold text-white">🎮 Host Controls</h3>

						<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
							<button
								onclick={previousPresentation}
								disabled={currentPresentationIndex() === 0}
								class="rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-600"
							>
								⏮ Previous
							</button>

							<button
								onclick={nextPresentation}
								class="px-4 py-3 {currentPresentationIndex() === localOrderedGroups.length - 1
									? 'bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600'
									: 'bg-blue-600 hover:bg-blue-700'} rounded-lg font-semibold text-white transition"
							>
								{#if currentPresentationIndex() === localOrderedGroups.length - 1}
									🏆 Winners
								{:else}
									Next ⏭
								{/if}
							</button>

							<button
								onclick={endPresentation}
								class="col-span-2 rounded-lg bg-purple-600 px-4 py-3 font-semibold text-white transition hover:bg-purple-700 md:col-span-4"
							>
								🏁 Return to Lobby
							</button>
						</div>
					</div>

					<!-- Presentation Order Management During Live -->
					{@const currentPres = currentPresentation()}
					<div class="glass-bright mt-6 rounded-2xl border border-white/20 p-6 shadow-xl">
						<h3 class="mb-4 text-xl font-bold text-white">📋 Presentation Order</h3>
						<p class="mb-4 text-sm text-white/70">Drag to reorder upcoming presentations</p>

						<div bind:this={presentationListElement} class="space-y-2">
							{#each localOrderedGroups || [] as group, index (group.id)}
								{@const isCurrent = currentPres?.id === group.id}
								<div
									data-group-id={group.id}
									class="{isCurrent
										? 'border border-green-500 bg-green-500/20'
										: 'bg-white/5 hover:bg-white/10'} flex items-center gap-3 rounded-lg p-3 transition"
								>
									<button
										class="drag-handle cursor-grab text-white/50 transition hover:text-white active:cursor-grabbing"
										aria-label="Drag to reorder"
									>
										<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
											<path
												d="M7 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 2zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 14zm6-8a2 2 0 1 0-.001-4.001A2 2 0 0 0 13 6zm0 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 14z"
											></path>
										</svg>
									</button>

									<span class="text-xl">{group.emoji || "📊"}</span>

									<div class="flex-1">
										<p class="font-semibold text-white">{group.name}</p>
										<p class="text-xs text-white/50">
											{group.members?.map((m: any) => m.user.name).join(", ") || "No members"}
										</p>
									</div>

									<span class="font-bold text-white/30">#{index + 1}</span>

									{#if isCurrent}
										<span class="rounded bg-green-500 px-2 py-1 text-xs font-bold text-white">
											CURRENT
										</span>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<!-- Timer Modal -->
{#if showTimerModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) showTimerModal = false;
		}}
		onkeydown={(e) => {
			if (e.key === "Escape") showTimerModal = false;
		}}
	>
		<div
			class="glass-bright-strong w-full max-w-md rounded-2xl border-2 border-purple-400/40 p-8 shadow-2xl"
		>
			<h2 class="mb-4 text-2xl font-bold text-white">⏱️ Start Timer</h2>
			<p class="mb-6 text-white/70">
				Set a countdown timer for this presentation. Everyone will see the same timer.
			</p>

			<label class="mb-6 block">
				<span class="mb-2 block font-semibold text-white">Duration (minutes)</span>
				<input
					type="number"
					bind:value={timerMinutes}
					min="1"
					max="60"
					class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-3 text-center text-2xl font-bold text-white focus:border-transparent focus:ring-2 focus:ring-purple-500"
				/>
			</label>

			<div class="flex gap-4">
				<button
					type="button"
					onclick={() => (showTimerModal = false)}
					class="flex-1 rounded-lg bg-gray-700 px-6 py-3 font-semibold text-white transition hover:bg-gray-600"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={startTimer}
					class="flex-1 rounded-lg bg-green-600 px-6 py-3 font-semibold text-white transition hover:bg-green-700"
				>
					Start Timer
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Pulsating Background Overlay when timer expires -->
{#if timerExpired && currentPresentation()}
	<div class="animate-pulsate-alarm pointer-events-none fixed inset-0 z-30"></div>
{/if}

<!-- Join Modal -->
{#if showJoinModal && !votingSession}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
		<div
			class="glass-bright-strong w-full max-w-md rounded-2xl border-2 border-purple-400/40 p-8 shadow-2xl"
		>
			<h3 class="mb-6 text-2xl font-bold">Join as Voter</h3>

			<form
				method="POST"
				action="?/createVotingSession"
				use:enhance={() => {
					return async ({ result }) => {
						if (result.type === "success" && result.data?.sessionCode) {
							showJoinModal = false;
							if (typeof window !== "undefined") {
								window.location.href = `?session=${result.data.sessionCode}`;
							}
						}
					};
				}}
			>
				<label class="mb-6 block">
					<span class="mb-2 block font-semibold">Your Display Name</span>
					<input
						type="text"
						name="displayName"
						bind:value={displayName}
						placeholder="Enter your name..."
						required
						class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-3 focus:border-transparent focus:ring-2 focus:ring-purple-500"
					/>
				</label>

				<div class="flex gap-4">
					<button
						type="button"
						onclick={() => (showJoinModal = false)}
						class="flex-1 rounded-lg bg-gray-700 px-6 py-3 font-semibold transition hover:bg-gray-600"
					>
						Cancel
					</button>
					<button
						type="submit"
						class="flex-1 rounded-lg bg-purple-600 px-6 py-3 font-semibold transition hover:bg-purple-700"
					>
						Join
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	@keyframes gradient {
		0%,
		100% {
			background-position: 0% 50%;
		}
		50% {
			background-position: 100% 50%;
		}
	}

	.animate-gradient {
		background-size: 200% 200%;
		animation: gradient 8s ease infinite;
	}

	@keyframes float-random {
		0%,
		100% {
			transform: translate(0, 0) rotate(0deg);
		}
		25% {
			transform: translate(40px, -40px) rotate(90deg);
		}
		50% {
			transform: translate(-30px, -70px) rotate(180deg);
		}
		75% {
			transform: translate(-60px, -30px) rotate(270deg);
		}
	}

	.animate-float-random {
		animation: float-random linear infinite;
		will-change: transform;
	}

	@keyframes float-slow {
		0%,
		100% {
			transform: translate(0, 0) rotate(0deg);
		}
		25% {
			transform: translate(30px, -30px) rotate(90deg);
		}
		50% {
			transform: translate(60px, 0) rotate(180deg);
		}
		75% {
			transform: translate(30px, 30px) rotate(270deg);
		}
	}

	@keyframes float-medium {
		0%,
		100% {
			transform: translate(0, 0) rotate(0deg);
		}
		33% {
			transform: translate(-40px, 40px) rotate(120deg);
		}
		66% {
			transform: translate(40px, -20px) rotate(240deg);
		}
	}

	@keyframes float-fast {
		0%,
		100% {
			transform: translate(0, 0) scale(1);
		}
		50% {
			transform: translate(-50px, 50px) scale(1.2);
		}
	}

	@keyframes star-pulse {
		0%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.2);
		}
	}

	@keyframes pulsate-alarm {
		0%,
		100% {
			background-color: rgba(239, 68, 68, 0);
		}
		50% {
			background-color: rgba(239, 68, 68, 0.3);
		}
	}

	.animate-pulsate-alarm {
		animation: pulsate-alarm 1.5s ease-in-out infinite;
	}

	button:active svg {
		animation: star-pulse 0.3s ease;
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.transition-opacity {
		animation: fadeIn 500ms ease-out;
	}

	/* Winners Screen Animations */
	@keyframes float {
		0%,
		100% {
			transform: translateY(0) rotate(0deg);
		}
		50% {
			transform: translateY(-20px) rotate(180deg);
		}
	}

	@keyframes fade-in-down {
		from {
			opacity: 0;
			transform: translateY(-50px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes slide-up-bounce {
		0% {
			opacity: 0;
			transform: translateY(150px);
		}
		50% {
			opacity: 1;
		}
		70% {
			transform: translateY(-15px);
		}
		85% {
			transform: translateY(5px);
		}
		100% {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes slide-up-bounce-large {
		0% {
			opacity: 0;
			transform: translateY(200px) scale(0.9);
		}
		50% {
			opacity: 1;
		}
		70% {
			transform: translateY(-20px) scale(1.05);
		}
		85% {
			transform: translateY(8px) scale(0.98);
		}
		100% {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@keyframes pulse-slow {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.8;
			transform: scale(1.05);
		}
	}

	@keyframes spin-slow {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes confetti {
		0% {
			transform: translateY(0) rotate(0deg);
			opacity: 1;
		}
		100% {
			transform: translateY(100vh) rotate(720deg);
			opacity: 0;
		}
	}

	@keyframes star-burst {
		0% {
			transform: translate(-50%, -50%) scale(0) rotate(0deg);
			opacity: 1;
		}
		50% {
			opacity: 1;
		}
		100% {
			transform: translate(calc(-50% + var(--burst-x)), calc(-50% + var(--burst-y))) scale(1.5)
				rotate(var(--rotation));
			opacity: 0;
		}
	}

	.animate-float {
		animation: float 10s ease-in-out infinite;
	}

	.animate-fade-in-down {
		animation: fade-in-down 1s ease-out;
	}

	.animate-slide-up-bounce {
		animation: slide-up-bounce 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
	}

	.animate-slide-up-bounce-large {
		animation: slide-up-bounce-large 1s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
	}

	.animate-star-burst {
		animation: star-burst 1.2s ease-out forwards;
	}

	.animate-pulse-slow {
		animation: pulse-slow 3s ease-in-out infinite;
	}

	.animate-spin-slow {
		animation: spin-slow 3s linear infinite;
	}

	.animate-confetti {
		animation: confetti 5s ease-out forwards;
	}
</style>
