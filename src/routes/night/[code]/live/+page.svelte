<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll, goto } from '$app/navigation';
	import { onMount, onDestroy, untrack } from 'svelte';
	import QRCode from 'qrcode';
	import Sortable from 'sortablejs';
	import ParticleBackground from '$lib/components/ParticleBackground.svelte';
	
	const { data } = $props();
	let { event, orderedGroups, isHost, votingSession, votingSessions, participants, currentUser, currentPresentationVotes, totalPotentialVoters, existingVotes, userGroupIds, topPresentations, categoryWinners, fullLeaderboard } = $derived(data);
	
	// Simple background shapes for CSS animations
	interface BackgroundShape {
		id: number;
		type: 'circle' | 'square' | 'triangle';
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
		const colors = ['rgb(168 85 247 / 0.15)', 'rgb(236 72 153 / 0.15)', 'rgb(147 197 253 / 0.15)', 'rgb(129 140 248 / 0.15)', 'rgb(216 180 254 / 0.15)'];
		const types: ('circle' | 'square' | 'triangle')[] = ['circle', 'circle', 'square', 'square', 'triangle', 'circle', 'square', 'triangle'];
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
				duration: 15 + i * 3
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
		if (topPresentations.third.length > 0) places.push({ step: 1, label: '🥉 Reveal 3rd Place' });
		if (topPresentations.second.length > 0) places.push({ step: 2, label: '🥈 Reveal 2nd Place' });
		if (topPresentations.first.length > 0) places.push({ step: 3, label: '🥇 Reveal 1st Place' });
		places.push({ step: 4, label: '🎉 Show Confetti!' });
		return places;
	});
	
	// Get the next reveal step
	const nextRevealStep = $derived(() => {
		const places = existingPlaces();
		const currentIndex = places.findIndex(p => p.step > winnersRevealStep);
		return currentIndex >= 0 ? places[currentIndex] : null;
	});
	
	// Check for ties in top 3
	const hasTies = $derived(() => {
		return topPresentations.first.length > 1 || 
		       topPresentations.second.length > 1 || 
		       topPresentations.third.length > 1;
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
	
	let qrCodeUrl = $state('');
	let showJoinModal = $state(false);
	let displayName = $state('');
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
	let confettiPieces = $state<Array<{ id: number; left: number; delay: number; duration: number; color: string }>>([]);
	let confettiCounter = $state(0);
	let lastConfettiCount = $state(0);
	
	// Timer state
	let timerDisplay = $state('00:00');
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
		if (typeof window === 'undefined') return '';
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
		
		// Generate QR code with custom styling
		if (isHost) {
			try {
				const url = votingUrl();
				if (url) {
					qrCodeUrl = await QRCode.toDataURL(url, {
						width: 300,
						margin: 2,
						color: {
							dark: '#8b5cf6',  // Purple color matching the theme
							light: '#ffffff'
						},
						errorCorrectionLevel: 'M'
					});
				}
			} catch (err) {
				console.error('Failed to generate QR code:', err);
			}
		}
		
		// Initialize Sortable if needed
		if (isHost && presentationListElement) {
			try {
				sortableInstance = new Sortable(presentationListElement, {
					animation: 150,
					handle: '.drag-handle',
					onEnd: handleReorder,
				});
			} catch (e) {
				console.error('Failed to initialize sortable:', e);
			}
		}
		
		// Mark as initialized and set initial presentation ID
		lastPresentationId = event.currentPresentationId;
		
		// Load existing ratings if on a presentation
		loadRatingsForPresentation();
		
		isInitialized = true;
		
		// Poll for updates every second to keep timer in tight sync
		pollInterval = setInterval(() => {
			invalidateAll().catch(() => {
				// Silently ignore errors (e.g., if page is navigating away)
			});
		}, 1000);
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
			console.log('New confetti triggers detected! Count:', currentCount, 'Diff:', countDiff);
			
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
			timerDisplay = '00:00';
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
			timerDisplay = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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
			timerDisplay = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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
			const newOrder = items.map(item => item.getAttribute('data-group-id')).filter(Boolean) as string[];
			
			if (newOrder.length === 0) return;
			
			// Update local state immediately (optimistic update)
			const reorderedGroups = newOrder
				.map(id => localOrderedGroups.find((g: any) => g?.id === id))
				.filter(Boolean);
			
			if (reorderedGroups.length > 0) {
				localOrderedGroups = reorderedGroups;
			}
			
			// Save to server in background
			const formData = new FormData();
			formData.append('order', JSON.stringify(newOrder));
			fetch('?/reorderPresentations', {
				method: 'POST',
				body: formData,
			}).catch(err => {
				console.error('Failed to save presentation order:', err);
				// Optionally: revert to server state on error
			});
		} catch (e) {
			console.error('Error reordering presentations:', e);
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
			formData.append('groupId', groupId);
			fetch('?/setCurrentPresentation', {
				method: 'POST',
				body: formData,
			}).then(() => {
				return invalidateAll();
			}).then(() => {
				// Wait a bit before fading in
				setTimeout(() => {
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
			await fetch('?/showWinners', {
				method: 'POST',
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
			formData.append('groupId', '');
			fetch('?/setCurrentPresentation', {
				method: 'POST',
				body: formData,
			}).then(() => {
				return invalidateAll();
			}).then(() => {
				// Wait a bit before fading in
				setTimeout(() => {
					isTransitioning = false;
				}, 100);
			});
		}, 300);
	}
	
	function removeParticipant(userId: string) {
		if (!confirm('Remove this participant from the event?')) return;
		
		const formData = new FormData();
		formData.append('userId', userId);
		fetch('?/removeParticipant', {
			method: 'POST',
			body: formData,
		}).then(() => invalidateAll());
	}
	
	function removeVotingSession(sessionId: string) {
		if (!confirm('Remove this voter from the event?')) return;
		
		const formData = new FormData();
		formData.append('sessionId', sessionId);
		fetch('?/removeVotingSession', {
			method: 'POST',
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
		formData.append('groupId', currentPres.id);
		formData.append('categoryId', categoryId);
		formData.append('stars', stars.toString());
		
		try {
			const response = await fetch(`?/autoSaveRating${votingSession ? `&session=${votingSession.sessionCode}` : ''}`, {
				method: 'POST',
				body: formData,
			});
			
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
		if (!confirm('Are you sure you want to reset ALL votes for this event? This cannot be undone!')) return;
		
		const formData = new FormData();
		await fetch('?/resetVotes', {
			method: 'POST',
			body: formData,
		});
		
		await invalidateAll();
	}
	
	async function handleLogout() {
		const response = await fetch('/auth/logout', { method: 'POST' });
		if (response.ok) {
			goto('/');
		}
	}
	
	// Timer control functions
	async function startTimer() {
		const formData = new FormData();
		formData.append('minutes', timerMinutes.toString());
		
		showTimerModal = false;
		
		// Send to server and wait for response
		await fetch('?/startTimer', {
			method: 'POST',
			body: formData,
		});
		
		// Refresh data to get the server's timestamp
		await invalidateAll();
	}
	
	async function pauseTimer() {
		const formData = new FormData();
		await fetch('?/pauseTimer', {
			method: 'POST',
			body: formData,
		});
		await invalidateAll();
	}
	
	async function resumeTimer() {
		const formData = new FormData();
		await fetch('?/resumeTimer', {
			method: 'POST',
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
		await fetch('?/stopTimer', {
			method: 'POST',
			body: formData,
		});
		await invalidateAll();
	}
	
	// Close dropdown when clicking outside
	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.account-dropdown')) {
			accountDropdownOpen = false;
		}
	}
	
	async function showWinners() {
		if (!confirm('Show the winners screen? This will end the event.')) return;
		
		const formData = new FormData();
		await fetch('?/showWinners', {
			method: 'POST',
			body: formData,
		});
		
		await invalidateAll();
		showWinnersScreen = true;
	}
	
	async function revealNextWinner() {
		const next = nextRevealStep();
		if (!next) return;
		
		const formData = new FormData();
		formData.append('step', String(next.step));
		
		await fetch('?/revealWinner', {
			method: 'POST',
			body: formData,
		});
		
		await invalidateAll();
	}
	
	async function revealPreviousWinner() {
		if (winnersRevealStep <= 0) {
			// Go back to presentation mode
			showWinnersScreen = false;
			
			// Reset event status back to active
			await fetch('?/backToPresentations', { 
				method: 'POST', 
				body: new FormData() 
			});
			
			// Reset reveal step to 0
			const formData = new FormData();
			formData.append('step', '0');
			await fetch('?/revealWinner', { method: 'POST', body: formData });
			
			await invalidateAll();
			return;
		}
		
		// Find the previous reveal step
		const places = existingPlaces();
		const currentIndex = places.findIndex(p => p.step === winnersRevealStep);
		const prevPlace = currentIndex > 0 ? places[currentIndex - 1] : null;
		
		const prevStep = prevPlace ? prevPlace.step - 1 : winnersRevealStep - 1;
		const formData = new FormData();
		formData.append('step', String(Math.max(0, prevStep)));
		
		await fetch('?/revealWinner', {
			method: 'POST',
			body: formData,
		});
		
		await invalidateAll();
	}
	
	function shootConfetti() {
		const colors = ['#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE'];
		const newPieces = Array.from({ length: 50 }, (_, i) => ({
			id: confettiCounter + i,
			left: Math.random() * 100,
			delay: Math.random() * 0.3,
			duration: 3 + Math.random() * 2,
			color: colors[Math.floor(Math.random() * colors.length)]
		}));
		
		confettiPieces = [...confettiPieces, ...newPieces];
		confettiCounter += 50;
		
		// Clean up old confetti after animation
		setTimeout(() => {
			confettiPieces = confettiPieces.filter(p => p.id >= confettiCounter - 50);
		}, 6000);
	}
	
	async function triggerConfettiForEveryone() {
		console.log('Triggering confetti for everyone...');
		
		// Shoot locally first for instant feedback
		shootConfetti();
		
		// Trigger for everyone else via server
		try {
			const response = await fetch('?/triggerConfetti', {
				method: 'POST',
				body: new FormData()
			});
			
			if (!response.ok) {
				console.error('Failed to trigger confetti:', response.status, response.statusText);
				const text = await response.text();
				console.error('Response body:', text);
			} else {
				console.log('Confetti triggered successfully!');
			}
		} catch (error) {
			console.error('Error triggering confetti:', error);
		}
		
		// Force immediate reload so polling picks up the new timestamp
		await invalidateAll();
	}
</script>

<svelte:window onclick={handleClickOutside} />

<ParticleBackground />

<!-- Confetti Layer -->
{#if confettiPieces.length > 0}
	<div class="fixed inset-0 pointer-events-none z-50 overflow-hidden">
		{#each confettiPieces as piece (piece.id)}
			<div
				class="absolute w-3 h-3 animate-confetti"
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

<div class="relative min-h-screen bg-gradient-to-br from-purple-400/60 via-pink-400/55 to-blue-400/60 animate-gradient overflow-hidden">
	<!-- Background Shapes -->
	<div class="fixed inset-0 pointer-events-none overflow-hidden z-0">
		{#each backgroundShapes as shape (shape.id)}
			{#if shape.type === 'circle'}
				<div 
					class="absolute rounded-full animate-float-random"
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
			{:else if shape.type === 'square'}
				<div 
					class="absolute rounded-[2rem] animate-float-random"
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
			{:else if shape.type === 'triangle'}
				<svg 
					class="absolute animate-float-random" 
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
					<path d="M 50 10 L 90 90 L 10 90 Z" fill={shape.color} rx="8"/>
				</svg>
			{/if}
		{/each}
	</div>
	
	<!-- Star Particles (removed) -->
	
	{#if !isInitialized}
		<!-- Loading Screen -->
		<div class="min-h-screen flex items-center justify-center">
			<div class="text-center">
				<div class="w-16 h-16 border-4 border-white/20 border-t-white rounded-full animate-spin mx-auto mb-4"></div>
				<p class="text-white text-xl font-semibold">Loading...</p>
			</div>
		</div>
	{:else if showWinnersScreen || event.status === 'completed'}
		<!-- WINNERS SCREEN -->
		<div class="min-h-screen flex flex-col items-center justify-center p-8 relative overflow-hidden">
			<!-- Animated Background -->
			<div class="absolute inset-0 overflow-hidden">
				{#each Array(50) as _, i}
					<div 
						class="absolute w-2 h-2 bg-white/20 rounded-full animate-float"
						style="left: {Math.random() * 100}%; top: {Math.random() * 100}%; animation-delay: {Math.random() * 5}s; animation-duration: {5 + Math.random() * 5}s;"
					></div>
				{/each}
			</div>
			
			<!-- Title -->
			<div class="text-center mb-16 relative z-10 animate-fade-in-down">
				<h1 class="text-5xl sm:text-7xl md:text-9xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-pink-500 to-purple-600 mb-4 animate-pulse-slow whitespace-nowrap">
					🏆 WINNERS 🏆
				</h1>
				{#if hasRevealedTie()}
					<p class="text-lg md:text-xl text-yellow-300 font-bold mt-2 animate-pulse">
						⚡ We have a tie! ⚡
					</p>
				{/if}
			</div>
			
			<!-- Podium -->
			<div class="mb-12 relative z-10 w-full px-2 sm:px-4 pt-16 sm:pt-20">
				<div class="flex items-end justify-center gap-1 sm:gap-2 md:gap-4 lg:gap-6 xl:gap-8 mx-auto">
					<!-- Third Place (#3) -->
					{#each topPresentations.third as presentation, idx}
						<div 
							class="flex flex-col items-center w-24 sm:w-32 md:w-48 lg:flex-1 lg:min-w-[200px] lg:max-w-[280px]"
							class:animate-slide-up-bounce={winnersRevealStep >= 1}
							style="
								opacity: {winnersRevealStep >= 1 ? '1' : '0'};
								visibility: {winnersRevealStep >= 1 ? 'visible' : 'hidden'};
								animation-delay: {idx * 0.15}s;
								transition: opacity 0.3s ease-in-out;
							"
						>
							<div class="mb-2 sm:mb-3 md:mb-4 lg:mb-6 text-center px-2 sm:px-4 md:px-6 lg:px-8 py-2 sm:py-3 md:py-4 lg:py-6 bg-gradient-to-br from-orange-400 to-orange-600 rounded-lg sm:rounded-xl md:rounded-2xl lg:rounded-3xl shadow-2xl transform hover:scale-105 transition-all w-full">
								<div class="text-3xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl mb-1 sm:mb-2 md:mb-3">{presentation.group.emoji || '🎯'}</div>
								<h3 class="text-xs sm:text-lg md:text-xl lg:text-2xl xl:text-4xl font-bold text-white mb-1 sm:mb-2 line-clamp-2">{presentation.group.name}</h3>
								<p class="text-xs sm:text-sm md:text-base lg:text-lg text-orange-100 mb-1 sm:mb-2 md:mb-3 hidden md:block line-clamp-2">
									{presentation.group.members?.map((m: any) => m.user.name).join(', ')}
								</p>
								<div class="bg-white/50 rounded-md sm:rounded-lg md:rounded-xl px-2 sm:px-3 md:px-4 lg:px-6 py-1 sm:py-2 md:py-3">
									<div class="text-lg sm:text-2xl md:text-3xl lg:text-4xl xl:text-5xl font-black text-orange-900">★ {presentation.totalScore}</div>
									<div class="text-xs sm:text-sm md:text-base lg:text-lg text-orange-800">{presentation.voteCount} votes</div>
								</div>
							</div>
							<div class="w-full h-16 sm:h-24 md:h-32 lg:h-40 xl:h-48 bg-gradient-to-t from-orange-600 to-orange-400 rounded-t-lg sm:rounded-t-xl md:rounded-t-2xl border-2 sm:border-4 md:border-6 border-orange-700 flex items-center justify-center shadow-2xl">
								<span class="text-3xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-black text-orange-900">3</span>
							</div>
						</div>
					{/each}
					
					<!-- Second Place (#2) -->
					{#each topPresentations.second as presentation, idx}
						<div 
							class="flex flex-col items-center w-28 sm:w-36 md:w-52 lg:flex-1 lg:min-w-[220px] lg:max-w-[300px]"
							class:animate-slide-up-bounce={winnersRevealStep >= 2}
							style="
								opacity: {winnersRevealStep >= 2 ? '1' : '0'};
								visibility: {winnersRevealStep >= 2 ? 'visible' : 'hidden'};
								animation-delay: {0.2 + idx * 0.15}s;
								transition: opacity 0.3s ease-in-out;
							"
						>
							<div class="mb-3 sm:mb-4 md:mb-6 text-center px-4 sm:px-6 md:px-8 py-3 sm:py-4 md:py-6 bg-gradient-to-br from-gray-300 to-gray-500 rounded-xl sm:rounded-2xl md:rounded-3xl shadow-2xl transform hover:scale-105 transition-all w-full">
								<div class="text-2xl sm:text-3xl md:text-4xl lg:text-6xl mb-1">{presentation.group.emoji || '�'}</div>
								<h3 class="text-lg sm:text-xl md:text-2xl lg:text-4xl font-bold text-gray-900 mb-2">{presentation.group.name}</h3>
								<p class="text-sm sm:text-base md:text-lg text-gray-700 mb-2 sm:mb-3 hidden md:block">
									{presentation.group.members?.map((m: any) => m.user.name).join(', ')}
								</p>
								<div class="bg-white/50 rounded-md sm:rounded-lg md:rounded-xl px-2 sm:px-3 md:px-4 lg:px-6 py-1 sm:py-2 md:py-3">
									<div class="text-lg sm:text-2xl md:text-3xl lg:text-4xl xl:text-5xl font-black text-gray-900">★ {presentation.totalScore}</div>
									<div class="text-xs sm:text-sm md:text-base lg:text-lg text-gray-700">{presentation.voteCount} votes</div>
								</div>
							</div>
							<div class="w-full h-20 sm:h-32 md:h-40 lg:h-48 xl:h-56 bg-gradient-to-t from-gray-400 to-gray-300 rounded-t-lg sm:rounded-t-xl md:rounded-t-2xl border-2 sm:border-4 md:border-6 border-gray-500 flex items-center justify-center shadow-2xl">
								<span class="text-3xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-black text-gray-800">2</span>
							</div>
						</div>
					{/each}
					
					<!-- First Place (#1) -->
					{#each topPresentations.first as presentation, idx}
						<div 
							class="flex flex-col items-center w-32 sm:w-40 md:w-56 lg:flex-1 lg:min-w-[240px] lg:max-w-[320px] relative"
							class:animate-slide-up-bounce-large={winnersRevealStep >= 3}
							style="
								opacity: {winnersRevealStep >= 3 ? '1' : '0'};
								visibility: {winnersRevealStep >= 3 ? 'visible' : 'hidden'};
								animation-delay: {idx * 0.15}s;
								transition: opacity 0.3s ease-in-out;
							"
						>
							<div class="mb-3 sm:mb-4 md:mb-6 text-center px-6 sm:px-8 md:px-10 py-4 sm:py-6 md:py-8 bg-gradient-to-br from-yellow-300 via-yellow-400 to-yellow-500 rounded-xl sm:rounded-2xl md:rounded-3xl shadow-2xl transform hover:scale-105 transition-all border-4 sm:border-6 border-yellow-600 relative w-full">
								{#if winnersRevealStep >= 4}
									<div class="absolute -top-8 sm:-top-10 md:-top-12 -left-6 sm:-left-8 md:-left-10 text-5xl sm:text-6xl md:text-7xl lg:text-8xl animate-spin-slow">👑</div>
									<div class="absolute -top-8 sm:-top-10 md:-top-12 -right-6 sm:-right-8 md:-right-10 text-5xl sm:text-6xl md:text-7xl lg:text-8xl animate-spin-slow" style="animation-delay: 0.5s;">👑</div>
								{/if}
								<div class="text-3xl sm:text-4xl md:text-6xl lg:text-8xl mb-1 sm:mb-2">{presentation.group.emoji || '�'}</div>
								<h3 class="text-sm sm:text-lg md:text-2xl lg:text-3xl font-black text-gray-900 mb-1 line-clamp-1">{presentation.group.name}</h3>
								<p class="text-xs sm:text-sm md:text-base text-gray-800 mb-1 sm:mb-2 font-semibold hidden md:block line-clamp-1">
									{presentation.group.members?.map((m: any) => m.user.name).join(', ')}
								</p>
								<div class="bg-white/80 rounded-md sm:rounded-xl md:rounded-xl px-2 sm:px-4 md:px-6 lg:px-8 py-2 sm:py-3 md:py-4">
									<div class="text-xl sm:text-3xl md:text-4xl lg:text-5xl xl:text-6xl font-black text-yellow-600">★ {presentation.totalScore}</div>
									<div class="text-xs sm:text-base md:text-lg lg:text-xl text-gray-800 font-semibold">{presentation.voteCount} votes</div>
								</div>
								
								<!-- Star Explosion when first place appears -->
								{#if winnersRevealStep >= 3}
									<div class="absolute inset-0 flex items-center justify-center pointer-events-none overflow-visible">
										{#each Array(50) as _, i}
											<div 
												class="absolute animate-star-burst"
												style="
													font-size: {1 + Math.random() * 2}rem;
													--burst-x: {(Math.cos(i * 137.5 * Math.PI / 180) * (100 + Math.random() * 100))}px;
													--burst-y: {(Math.sin(i * 137.5 * Math.PI / 180) * (100 + Math.random() * 100))}px;
													--rotation: {Math.random() * 720 - 360}deg;
													animation-duration: {0.8 + Math.random() * 0.6}s;
												"
											>⭐</div>
										{/each}
									</div>
								{/if}
							</div>
							<div class="w-full h-24 sm:h-40 md:h-48 lg:h-56 xl:h-64 bg-gradient-to-t from-yellow-500 to-yellow-300 rounded-t-lg sm:rounded-t-xl md:rounded-t-2xl border-2 sm:border-4 md:border-6 border-yellow-600 flex items-center justify-center shadow-2xl">
								<span class="text-4xl sm:text-6xl md:text-7xl lg:text-8xl xl:text-9xl font-black text-yellow-800">1</span>
							</div>
						</div>
					{/each}
				</div>
			</div>
			
			<!-- Confetti Animation -->
			{#if winnersRevealStep >= 4}
				<div class="fixed inset-0 pointer-events-none z-50">
					{#each Array(100) as _, i}
						<div 
							class="absolute w-3 h-3 animate-confetti"
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
				<div class="relative z-10 w-full max-w-6xl px-4 mb-12 animate-fade-in-down" style="animation-delay: 2s;">
					<h2 class="text-3xl sm:text-4xl md:text-5xl font-black text-white text-center mb-8">🏅 Category Champions</h2>
					<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
						{#each categoryWinners as catWinner}
							<div class="glass-bright rounded-2xl p-4 sm:p-6 border-2 border-purple-300/40 shadow-xl hover:scale-105 transition-all">
								<h3 class="text-lg sm:text-xl font-bold text-yellow-400 mb-3">
									{catWinner.category.name}
									{#if catWinner.isTie}
										<span class="text-xs text-white/70 ml-2">(TIE)</span>
									{/if}
								</h3>
								
								{#each catWinner.winners as winner}
									<div class="flex items-center gap-3 mb-3 last:mb-0">
										<div class="text-2xl sm:text-3xl">{winner.group.emoji || '🎯'}</div>
										<div class="flex-1">
											<p class="text-white font-semibold text-sm sm:text-base">{winner.group.name}</p>
											<p class="text-white/60 text-xs">
												{winner.group.members?.map((m: any) => m.user.name).join(', ')}
											</p>
										</div>
									</div>
								{/each}
								
								<div class="bg-white/20 rounded-lg px-3 py-2 text-center mt-2">
									<div class="text-xl sm:text-2xl font-black text-yellow-300">★ {catWinner.winners[0].score.toFixed(2)}</div>
								</div>
							</div>
						{/each}
					</div>
				</div>
				
				<!-- Full Leaderboard (Collapsible) -->
				<div class="relative z-10 w-full max-w-4xl px-4 mb-12 animate-fade-in-down" style="animation-delay: 3s;">
					<button
						onclick={() => showLeaderboard = !showLeaderboard}
						class="w-full glass-bright rounded-2xl p-6 border-2 border-white/20 shadow-xl hover:bg-white/20 transition-all mb-4"
					>
						<div class="flex items-center justify-between">
							<h2 class="text-2xl sm:text-3xl font-black text-white">📊 Full Leaderboard</h2>
							<span class="text-white text-2xl">{showLeaderboard ? '▼' : '▶'}</span>
						</div>
					</button>
					
					{#if showLeaderboard}
						<div class="glass-bright rounded-2xl border-2 border-white/20 shadow-xl overflow-hidden animate-slide-up-bounce">
							<div class="overflow-x-auto">
								<table class="w-full">
									<thead class="bg-white/20">
										<tr>
											<th class="px-4 py-3 text-left text-white font-bold">#</th>
											<th class="px-4 py-3 text-left text-white font-bold">Team</th>
											<th class="px-4 py-3 text-center text-white font-bold hidden sm:table-cell">Members</th>
											<th class="px-4 py-3 text-center text-white font-bold">Avg Stars</th>
											<th class="px-4 py-3 text-center text-white font-bold">Votes</th>
										</tr>
									</thead>
									<tbody>
										{#each fullLeaderboard as item, idx}
											<tr class="border-t border-white/10 hover:bg-white/10 transition-colors">
												<td class="px-4 py-3 text-white font-bold text-lg">{idx + 1}</td>
												<td class="px-4 py-3">
													<div class="flex items-center gap-2">
														<span class="text-2xl sm:text-3xl">{item.group.emoji || '🎯'}</span>
														<span class="text-white font-semibold text-sm sm:text-base">{item.group.name}</span>
													</div>
												</td>
												<td class="px-4 py-3 text-white/70 text-xs sm:text-sm text-center hidden sm:table-cell">
													{item.group.members?.map((m: any) => m.user.name).join(', ')}
												</td>
												<td class="px-4 py-3 text-center">
													<div class="flex items-center justify-center gap-1">
														{#each Array(5) as _, i}
															<svg 
																class="w-4 h-4 sm:w-5 sm:h-5" 
																fill={i < Math.round(item.averageScore) ? '#FFD700' : 'none'} 
																stroke="#FFD700" 
																stroke-width="2" 
																viewBox="0 0 24 24"
															>
																<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
															</svg>
														{/each}
														<span class="text-yellow-300 font-bold text-sm sm:text-base ml-2">{item.averageScore.toFixed(1)}</span>
													</div>
												</td>
												<td class="px-4 py-3 text-white text-center text-sm sm:text-base">{item.voteCount}</td>
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
					class="px-10 py-5 bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500 hover:from-pink-600 hover:via-purple-600 hover:to-indigo-600 text-white rounded-full font-black text-xl transition shadow-2xl border-4 border-white/50 transform hover:scale-110 active:scale-95"
				>
					🎉 Confetti Cannon! 🎉
				</button>
			</div>
			
			<!-- Actions -->
			{#if isHost}
				<div class="relative z-10 mt-12 flex gap-4 flex-wrap justify-center">
					<button
						onclick={revealPreviousWinner}
						class="px-8 py-4 bg-white/20 hover:bg-white/30 text-white rounded-xl font-bold text-lg transition backdrop-blur-xl border-2 border-white/30"
					>
						← {winnersRevealStep === 0 ? 'Back to Presentations' : 'Previous'}
					</button>
					{#if nextRevealStep()}
						<button
							onclick={revealNextWinner}
							class="px-12 py-5 bg-gradient-to-r from-yellow-400 via-yellow-500 to-yellow-600 hover:from-yellow-500 hover:via-yellow-600 hover:to-yellow-700 text-gray-900 rounded-xl font-black text-2xl transition shadow-2xl border-4 border-yellow-300 animate-pulse-slow"
						>
							{nextRevealStep()?.label || 'Next'}
						</button>
					{/if}
					<button
						onclick={async () => {
							showWinnersScreen = false;
							const formData = new FormData();
							formData.append('step', '0');
							await fetch('?/revealWinner', { method: 'POST', body: formData });
							await invalidateAll();
						}}
						class="px-8 py-4 bg-white/20 hover:bg-white/30 text-white rounded-xl font-bold text-lg transition backdrop-blur-xl border-2 border-white/30"
					>
						Back to Lobby
					</button>
					<button
						onclick={() => goto('/dashboard')}
						class="px-8 py-4 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold text-lg transition shadow-xl"
					>
						Dashboard
					</button>
				</div>
			{/if}
		</div>
	{:else if !currentPresentation()}
	<!-- LOBBY/STAGING SCREEN (before host starts) -->
		<div class="min-h-screen p-8 transition-opacity duration-500" class:opacity-0={isTransitioning}>
			<div class="max-w-7xl mx-auto">
				<!-- Header -->
				<div class="text-center mb-8">
					<h1 class="text-6xl font-bold text-white mb-4">{event.name}</h1>
					<div class="inline-flex items-center gap-3 glass-bright rounded-full px-6 py-3 border border-white/20">
						<div class="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div>
						<span class="text-white font-semibold">Live Lobby</span>
					</div>
				</div>

				<div class="grid lg:grid-cols-3 gap-6">
					<!-- Left Column: QR Code & Link (Host) or Join (Non-host) -->
					<div class="lg:col-span-1 space-y-6">
						{#if isHost}
							<!-- Host: QR Code & Link -->
							<div class="glass-bright rounded-2xl p-6 border-2 border-purple-300/40 shadow-xl">
								<h2 class="text-2xl font-bold text-white mb-4">📱 Join Link</h2>
								
								{#if qrCodeUrl}
									<div class="bg-gradient-to-br from-purple-500 to-pink-500 rounded-2xl p-1 mb-4">
										<div class="bg-white rounded-xl p-4">
											<img src={qrCodeUrl} alt="Join QR Code" class="w-full max-w-[240px] mx-auto" />
										</div>
									</div>
								{/if}
								
								<div class="bg-white/20 rounded-lg p-3 mb-4 border border-white/10">
									<p class="text-white text-center font-mono text-sm break-all">
										{votingUrl()}
									</p>
								</div>
								
								<p class="text-white/70 text-sm text-center">
									Share this link or QR code with voters
								</p>
							</div>

							<!-- Participants List -->
							<div class="glass-bright rounded-2xl p-6 border-2 border-purple-300/40 shadow-xl">
								<div class="flex justify-between items-center mb-4">
									<h2 class="text-xl font-bold text-white">
										👥 Participants ({totalParticipants()})
									</h2>
									<button
										onclick={() => showParticipants = !showParticipants}
										class="text-white/70 hover:text-white transition"
									>
										{showParticipants ? '▼' : '▶'}
									</button>
								</div>
								
								{#if showParticipants}
									<div class="space-y-2 max-h-96 overflow-y-auto">
										<!-- Logged in participants -->
										{#each participants as participant}
											<div class="bg-white/5 rounded-lg p-3 flex justify-between items-center">
												<div>
													<p class="text-white font-semibold">{participant.user.name}</p>
													<p class="text-white/50 text-xs">{participant.user.email}</p>
												</div>
												<button
													onclick={() => removeParticipant(participant.userId)}
													class="px-3 py-1 bg-red-600/20 hover:bg-red-600 text-red-300 hover:text-white rounded transition text-sm"
												>
													Remove
												</button>
											</div>
										{/each}
										
										<!-- Temp voters -->
										{#each votingSessions as session}
											<div class="bg-white/5 rounded-lg p-3 flex justify-between items-center">
												<div class="flex items-center gap-2 flex-1">
													<div class="w-2 h-2 bg-green-400 rounded-full"></div>
													<div>
														<p class="text-white font-semibold">{session.displayName}</p>
														<p class="text-white/50 text-xs">Temporary Voter</p>
													</div>
												</div>
												<button
													onclick={() => removeVotingSession(session.id)}
													class="px-3 py-1 bg-red-600/20 hover:bg-red-600 text-red-300 hover:text-white rounded transition text-sm"
												>
													Remove
												</button>
											</div>
										{/each}
									</div>
								{/if}
							</div>

							<!-- Reset Votes Button -->
							<div class="glass-bright rounded-2xl p-6 border-2 border-purple-300/40 shadow-xl">
								<h2 class="text-xl font-bold text-white mb-4">🔄 Vote Management</h2>
								<button
									onclick={resetAllVotes}
									class="w-full py-3 bg-red-600/20 hover:bg-red-600 text-red-300 hover:text-white rounded-lg font-semibold transition border border-red-600/50"
								>
									Reset All Votes
								</button>
								<p class="text-white/50 text-xs mt-2 text-center">
									This will delete all votes for this event
								</p>
							</div>
						{:else if !votingSession && !currentUser}
							<!-- Non-host: Join Button -->
							<div class="glass-bright-strong rounded-2xl p-8 border-2 border-purple-300/40 shadow-xl text-center">
								<div class="text-6xl mb-4">🎤</div>
								<h2 class="text-2xl font-bold text-white mb-4">Join as Voter</h2>
								<p class="text-white/70 mb-6">
									Enter your name to participate in the voting
								</p>
								<button
									onclick={() => showJoinModal = true}
									class="w-full py-4 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-semibold text-lg transition-all transform hover:scale-105 shadow-lg"
								>
									Join Now
								</button>
							</div>
						{:else}
							<!-- Joined: Waiting -->
							<div class="glass-bright-strong rounded-2xl p-8 border-2 border-purple-300/40 shadow-xl text-center">
								<div class="w-20 h-20 mx-auto mb-6 relative">
									<div class="absolute inset-0 bg-green-500 rounded-full animate-ping opacity-20"></div>
									<div class="absolute inset-0 bg-green-600 rounded-full flex items-center justify-center">
										<span class="text-3xl">✓</span>
									</div>
								</div>
								<h2 class="text-2xl font-bold text-white mb-2">
									You're In!
								</h2>
								<p class="text-white/70">
									{#if votingSession}
										Joined as: <span class="font-semibold text-white">{votingSession.displayName}</span>
									{:else}
										{currentUser?.name}
									{/if}
								</p>
								<p class="text-white/50 text-sm mt-4">
									Waiting for host to start...
								</p>
							</div>
						{/if}
					</div>

					<!-- Right Column: Presentation Order -->
					<div class="lg:col-span-2">
						<div class="glass-bright rounded-2xl p-6 border-2 border-purple-300/40 shadow-xl">
							<h2 class="text-2xl font-bold text-white mb-4">
								📋 Presentation Order ({localOrderedGroups?.length || 0})
							</h2>
							
							{#if !localOrderedGroups || localOrderedGroups.length === 0}
								<div class="text-center py-12">
									<p class="text-white/50">No presentations submitted yet</p>
								</div>
							{:else}
								<div bind:this={presentationListElement} class="space-y-3">
									{#each localOrderedGroups || [] as group, index (group.id)}
										<div
											data-group-id={group.id}
											class="bg-white/5 rounded-xl p-4 flex items-center gap-4 hover:bg-white/10 transition"
										>
											{#if isHost}
												<button class="drag-handle cursor-grab active:cursor-grabbing text-white/50 hover:text-white transition" aria-label="Drag to reorder">
													<svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
														<path d="M7 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 2zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 14zm6-8a2 2 0 1 0-.001-4.001A2 2 0 0 0 13 6zm0 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 14z"></path>
													</svg>
												</button>
											{/if}
											
											<div class="flex-1">
												<div class="flex items-center gap-3 mb-2">
													<span class="text-2xl">{group.emoji || '📊'}</span>
													<div class="flex-1">
														<h3 class="text-xl font-bold text-white">{group.name}</h3>
														<p class="text-white/50 text-sm">
															{group.members?.map((m: any) => m.user.name).join(', ') || 'No members'}
														</p>
													</div>
													<span class="text-white/30 text-3xl font-bold">#{index + 1}</span>
												</div>
											</div>
										</div>
									{/each}
								</div>
								
								{#if isHost && localOrderedGroups && localOrderedGroups.length > 0}
									<div class="mt-6 space-y-3">
										<button
											onclick={() => startPresentation(localOrderedGroups[0].id)}
											class="w-full py-4 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white rounded-xl font-bold text-xl transition-all transform hover:scale-105 shadow-lg"
										>
											🎬 Start First Presentation
										</button>
										<button
											onclick={showWinners}
											class="w-full py-4 bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 text-white rounded-xl font-bold text-xl transition-all transform hover:scale-105 shadow-lg"
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
		
		<div class="min-h-screen p-4 md:p-8 transition-opacity duration-500" class:opacity-0={isTransitioning}>
			<!-- Top Navigation Bar -->
			<nav class="fixed top-0 left-0 right-0 z-50 bg-theater-dark border-b border-gray-800">
				<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
					<div class="flex justify-between items-center h-16 gap-4">
						<!-- Logo/Brand -->
						<button 
							onclick={() => goto('/dashboard')}
							class="flex items-center gap-2 text-xl font-bold text-white hover:text-purple-400 transition flex-shrink-0"
						>
							<span class="text-2xl">🎤</span>
							<span class="hidden sm:inline">SlideNight</span>
							<span class="sm:hidden">SN</span>
						</button>
						
						<!-- Center: Progress Bar with Live indicator -->
						<div class="flex-1 flex items-center gap-3 max-w-2xl">
							<div class="flex items-center gap-2 flex-shrink-0">
								<div class="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
								<span class="text-white/70 text-sm hidden md:inline">Live</span>
							</div>
							
							{#if canVote && currentPresentation()}
								<div class="flex items-center gap-2 px-2 py-1 rounded-lg flex-shrink-0 {hasVotedForCurrent ? 'bg-green-500/20 border border-green-500/50' : 'bg-yellow-500/20 border border-yellow-500/50'}">
									{#if hasVotedForCurrent}
										<svg class="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
											<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
										</svg>
										<span class="text-green-400 text-xs font-semibold hidden sm:inline">Voted</span>
									{:else}
										<svg class="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
											<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
										</svg>
										<span class="text-yellow-400 text-xs font-semibold hidden sm:inline">Vote Now</span>
									{/if}
								</div>
							{/if}
							
							<div class="text-sm text-white/70 flex-shrink-0">
								{currentPresentationVotes || 0}/{totalPotentialVoters || 0}
							</div>
							<div class="flex-1 h-6 bg-gray-700 rounded-full overflow-hidden border border-gray-600">
								<div 
									class="h-full bg-gradient-to-r from-yellow-400 via-yellow-500 to-yellow-600 transition-all duration-500 ease-out flex items-center justify-end pr-2"
									style="width: {totalPotentialVoters > 0 ? (currentPresentationVotes / totalPotentialVoters * 100) : 0}%"
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
							<div class="relative account-dropdown flex-shrink-0">
								<button
									onclick={() => accountDropdownOpen = !accountDropdownOpen}
									class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-800 transition"
								>
									<div class="w-8 h-8 rounded-full bg-theater-purple flex items-center justify-center text-white font-semibold">
										{currentUser.name?.charAt(0).toUpperCase()}
									</div>
									<span class="text-white hidden sm:inline">{currentUser.name}</span>
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
											<p class="text-sm text-white font-semibold">{currentUser.name}</p>
											<p class="text-xs text-gray-400 truncate">{currentUser.email}</p>
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
						{:else if votingSession}
							<div class="flex-shrink-0 flex items-center gap-2 px-3 py-2">
								<div class="w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-white font-semibold">
									{votingSession.displayName?.charAt(0).toUpperCase()}
								</div>
								<span class="text-white hidden sm:inline">{votingSession.displayName}</span>
							</div>
						{:else}
							<div class="flex-shrink-0 px-3 py-2">
								<div class="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-xl">
									🎤
								</div>
							</div>
						{/if}
					</div>
				</div>
			</nav>
			
			<div class="max-w-6xl mx-auto pt-20">

				<!-- Presentation Header -->
				<div class="glass-bright rounded-2xl p-6 mb-6 border border-white/20 shadow-xl">
					<div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
						<div class="flex items-center gap-4">
							<span class="text-5xl">{pres?.emoji || '📊'}</span>
							<div>
								<h2 class="text-3xl font-bold text-white mb-1">
									{pres?.name}
								</h2>
								<p class="text-white/70">
									{pres?.members?.map((m: any) => m.user.name).join(', ') || 'Unknown'}
								</p>
							</div>
						</div>
						
						<!-- Timer Display -->
						<div class="flex flex-col items-center gap-3">
							{#if timerDisplay !== '00:00'}
								<div class="text-center">
									<div class="text-5xl font-bold text-white mb-1 font-mono {timerExpired ? 'text-red-500 animate-pulse' : timerDisplay.startsWith('00:') && parseInt(timerDisplay.split(':')[1]) < 30 ? 'text-yellow-400' : 'text-white'}">
										{timerDisplay}
									</div>
									<p class="text-white/70 text-sm">
										{timerPaused ? '⏸️ Paused' : timerExpired ? '⏰ Time\'s Up!' : '⏱️ Time Remaining'}
									</p>
								</div>
							{/if}
							
							{#if isHost}
								<div class="flex gap-2">
									{#if timerDisplay === '00:00'}
										<button
											onclick={() => showTimerModal = true}
											class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold text-sm transition flex items-center gap-2"
										>
											<span>⏱️</span>
											<span>Start Timer</span>
										</button>
									{:else if timerPaused}
										<button
											onclick={resumeTimer}
											class="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold text-xs transition"
										>
											▶️ Resume
										</button>
										<button
											onclick={stopTimer}
											class="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-xs transition"
										>
											⏹️ Stop
										</button>
									{:else}
										<button
											onclick={pauseTimer}
											class="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg font-semibold text-xs transition"
										>
											⏸️ Pause
										</button>
										<button
											onclick={stopTimer}
											class="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-xs transition"
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
					<div class="glass-bright rounded-2xl p-8 mb-6 border border-white/20 shadow-xl">
						{#if isOwnPresentation()}
							<!-- Show message when it's user's own presentation -->
							<div class="text-center py-12">
								<div class="text-6xl mb-4">🚫</div>
								<h3 class="text-2xl font-bold text-white mb-4">
									This is Your Presentation
								</h3>
								<p class="text-white/70 text-lg">
									You cannot vote on your own presentation.
								</p>
								<p class="text-white/50 text-sm mt-2">
									Please wait for other presentations to rate.
								</p>
							</div>
						{:else}
							<!-- Normal voting interface -->
							<div class="flex justify-between items-center mb-6">
								<h3 class="text-2xl font-bold text-white">
									⭐ Rate This Presentation
								</h3>
								{#if savingRating}
									<div class="flex items-center gap-2 text-white/70 text-sm">
										<div class="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
										<span>Saving...</span>
									</div>
								{/if}
							</div>
							
							<div class="space-y-6">
								{#each event.categories as category}
									<div class="bg-white/5 rounded-xl p-6">
										<h4 class="text-xl font-semibold text-white mb-4">
											{category.name}
											{#if ratings[category.id]}
												<span class="text-yellow-400 ml-2">✓</span>
											{/if}
										</h4>
										{#if category.description}
											<p class="text-white/60 text-sm mb-4">{category.description}</p>
										{/if}
										
										<div class="flex gap-2 justify-center">
											{#each [1, 2, 3, 4, 5] as star}
												<button
													type="button"
													onclick={() => setRating(category.id, star)}
													onmouseenter={() => setHoveredStars(category.id, star)}
													onmouseleave={() => clearHoveredStars(category.id)}
													class="transition-all transform hover:scale-125"
													aria-label="Rate {star} stars"
												>
													<svg
														class="w-12 h-12 transition-all duration-200"
														fill={(hoveredStars[category.id] || ratings[category.id] || 0) >= star ? '#FFD700' : 'none'}
														stroke={(hoveredStars[category.id] || ratings[category.id] || 0) >= star ? '#FFD700' : '#FFFFFF'}
														stroke-width="2"
														viewBox="0 0 24 24"
													>
														<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
													</svg>
												</button>
											{/each}
										</div>
									</div>
								{/each}
							</div>
							
							{#if hasVotedForCurrent}
								<div class="mt-6 bg-green-500/20 border border-green-500/50 rounded-xl p-4 text-center">
									<p class="text-green-400 font-semibold flex items-center justify-center gap-2">
										<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
											<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
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
					<div class="glass-bright rounded-2xl p-6 border-2 border-purple-300/40 shadow-xl">
						<h3 class="text-xl font-bold text-white mb-4">🎮 Host Controls</h3>
						
						<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
							
							<button
								onclick={previousPresentation}
								disabled={currentPresentationIndex() === 0}
								class="px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition"
							>
								⏮ Previous
							</button>
							
							<button
								onclick={nextPresentation}
								class="px-4 py-3 {currentPresentationIndex() === localOrderedGroups.length - 1 ? 'bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600' : 'bg-blue-600 hover:bg-blue-700'} text-white rounded-lg font-semibold transition"
							>
								{#if currentPresentationIndex() === localOrderedGroups.length - 1}
									🏆 Winners
								{:else}
									Next ⏭
								{/if}
							</button>
							
							<button
								onclick={endPresentation}
								class="col-span-2 md:col-span-4 px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition"
							>
								🏁 Return to Lobby
							</button>
						</div>
					</div>

					<!-- Presentation Order Management During Live -->
					{@const currentPres = currentPresentation()}
					<div class="glass-bright rounded-2xl p-6 mt-6 border border-white/20 shadow-xl">
						<h3 class="text-xl font-bold text-white mb-4">📋 Presentation Order</h3>
						<p class="text-white/70 text-sm mb-4">Drag to reorder upcoming presentations</p>
						
						<div bind:this={presentationListElement} class="space-y-2">
							{#each localOrderedGroups || [] as group, index (group.id)}
								{@const isCurrent = currentPres?.id === group.id}
								<div
									data-group-id={group.id}
									class="{isCurrent ? 'bg-green-500/20 border border-green-500' : 'bg-white/5 hover:bg-white/10'} rounded-lg p-3 flex items-center gap-3 transition"
								>
									<button class="drag-handle cursor-grab active:cursor-grabbing text-white/50 hover:text-white transition" aria-label="Drag to reorder">
										<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
											<path d="M7 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 2zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 14zm6-8a2 2 0 1 0-.001-4.001A2 2 0 0 0 13 6zm0 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 14z"></path>
										</svg>
									</button>
									
									<span class="text-xl">{group.emoji || '📊'}</span>
									
									<div class="flex-1">
										<p class="text-white font-semibold">{group.name}</p>
										<p class="text-white/50 text-xs">
											{group.members?.map((m: any) => m.user.name).join(', ') || 'No members'}
										</p>
									</div>
									
									<span class="text-white/30 font-bold">#{index + 1}</span>
									
									{#if isCurrent}
										<span class="px-2 py-1 bg-green-500 text-white text-xs font-bold rounded">
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
	<div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) showTimerModal = false; }} onkeydown={(e) => { if (e.key === 'Escape') showTimerModal = false; }}>
		<div class="glass-bright-strong rounded-2xl p-8 max-w-md w-full border-2 border-purple-400/40 shadow-2xl">
			<h2 class="text-2xl font-bold text-white mb-4">⏱️ Start Timer</h2>
			<p class="text-white/70 mb-6">
				Set a countdown timer for this presentation. Everyone will see the same timer.
			</p>
			
			<label class="block mb-6">
				<span class="block mb-2 font-semibold text-white">Duration (minutes)</span>
				<input
					type="number"
					bind:value={timerMinutes}
					min="1"
					max="60"
					class="w-full px-4 py-3 bg-theater-darker border border-gray-700 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-white text-center text-2xl font-bold"
				/>
			</label>
			
			<div class="flex gap-4">
				<button
					type="button"
					onclick={() => showTimerModal = false}
					class="flex-1 px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={startTimer}
					class="flex-1 px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition"
				>
					Start Timer
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Pulsating Background Overlay when timer expires -->
{#if timerExpired && currentPresentation()}
	<div class="fixed inset-0 pointer-events-none z-30 animate-pulsate-alarm"></div>
{/if}

<!-- Join Modal -->
{#if showJoinModal && !votingSession}
	<div class="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
		<div class="glass-bright-strong rounded-2xl p-8 max-w-md w-full border-2 border-purple-400/40 shadow-2xl">
			<h3 class="text-2xl font-bold mb-6">Join as Voter</h3>
			
			<form
				method="POST"
				action="?/createVotingSession"
				use:enhance={() => {
					return async ({ result }) => {
						if (result.type === 'success' && result.data?.sessionCode) {
							showJoinModal = false;
							if (typeof window !== 'undefined') {
								window.location.href = `?session=${result.data.sessionCode}`;
							}
						}
					};
				}}
			>
				<label class="block mb-6">
					<span class="block mb-2 font-semibold">Your Display Name</span>
					<input
						type="text"
						name="displayName"
						bind:value={displayName}
						placeholder="Enter your name..."
						required
						class="w-full px-4 py-3 bg-theater-darker border border-gray-700 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
					/>
				</label>
				
				<div class="flex gap-4">
					<button
						type="button"
						onclick={() => showJoinModal = false}
						class="flex-1 px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg font-semibold transition"
					>
						Cancel
					</button>
					<button
						type="submit"
						class="flex-1 px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition"
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
		0%, 100% { background-position: 0% 50%; }
		50% { background-position: 100% 50%; }
	}
	
	.animate-gradient {
		background-size: 200% 200%;
		animation: gradient 8s ease infinite;
	}
	
	@keyframes float-random {
		0%, 100% {
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
		0%, 100% {
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
		0%, 100% {
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
		0%, 100% {
			transform: translate(0, 0) scale(1);
		}
		50% {
			transform: translate(-50px, 50px) scale(1.2);
		}
	}
	
	@keyframes star-pulse {
		0%, 100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.2);
		}
	}
	
	@keyframes pulsate-alarm {
		0%, 100% {
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
		0%, 100% {
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
		0%, 100% {
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
			transform: translate(calc(-50% + var(--burst-x)), calc(-50% + var(--burst-y))) scale(1.5) rotate(var(--rotation));
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
