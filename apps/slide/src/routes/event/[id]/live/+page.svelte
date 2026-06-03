<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { invalidateAll } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import QRCode from 'qrcode';
	import ParticleBackground from '$lib/components/ParticleBackground.svelte';
	
	const { data } = $props();
	const { event, orderedGroups, isHost, votingSession, currentUser } = data;
	
	let qrCodeUrl = $state('');
	let showJoinModal = $state(false);
	let displayName = $state('');
	let currentPresentationIndex = $state(0);
	let timerSeconds = $state(0);
	let timerRunning = $state(false);
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	let ratings = $state<Record<string, number>>({});
	let hoveredStars = $state<Record<string, number>>({});
	let hasVotedForCurrent = $state(false);
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	
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
	
	const TARGET_FPS = 30; // Target 30fps for better performance
	const FRAME_TIME = 1000 / TARGET_FPS;
	
	function initBackgroundShapes() {
		const shapes: BackgroundShape[] = [];
		const colors = ['rgb(168 85 247 / 0.15)', 'rgb(236 72 153 / 0.15)', 'rgb(147 197 253 / 0.15)', 'rgb(129 140 248 / 0.15)'];
		const types: ('circle' | 'square' | 'triangle')[] = ['circle', 'circle', 'square', 'square', 'triangle'];
		const sizes = [60, 68, 56, 64, 60];
		
		for (let i = 0; i < 5; i++) {
			shapes.push({
				id: i,
				type: types[i],
				color: colors[i % colors.length],
				size: sizes[i],
				left: (i * 20) % 100,
				top: (i * 25) % 100,
				delay: i * 2,
				duration: 18 + i * 3
			});
		}
		
		backgroundShapes = shapes;
	}
	
	// Get voting URL
	const votingUrl = $derived(() => {
		if (typeof window === 'undefined') return '';
		return `${window.location.origin}/event/${event.id}/live`;
	});
	
	// Current presentation
	const currentPresentation = $derived(() => {
		if (!event.currentPresentationId) return null;
		return orderedGroups.find((g: any) => g.id === event.currentPresentationId);
	});
	
	// Check if user can vote
	const canVote = $derived(!!votingSession || !!currentUser);
	
	// Format timer display
	const timerDisplay = $derived(() => {
		const mins = Math.floor(timerSeconds / 60);
		const secs = timerSeconds % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	});
	
	// Initialize ratings for current presentation
	$effect(() => {
		if (currentPresentation) {
			const newRatings: Record<string, number> = {};
			event.categories.forEach((cat: any) => {
				newRatings[cat.id] = ratings[cat.id] || 0;
			});
			ratings = newRatings;
			hasVotedForCurrent = false;
		}
	});
	
	onMount(async () => {
		// Generate QR code
		if (isHost) {
			try {
				qrCodeUrl = await QRCode.toDataURL(votingUrl());
			} catch (err) {
				console.error('Failed to generate QR code:', err);
			}
		}
		
		// Initialize background shapes
		initBackgroundShapes();
		
		// Poll for updates every 2 seconds
		pollInterval = setInterval(() => {
			invalidateAll();
		}, 2000);
	});
	
	onDestroy(() => {
		if (timerInterval) clearInterval(timerInterval);
		if (pollInterval) clearInterval(pollInterval);
	});
	
	function startPresentation(groupId: string, index: number) {
		currentPresentationIndex = index;
		
		// Set current presentation via form action
		const form = document.createElement('form');
		form.method = 'POST';
		form.action = '?/setCurrentPresentation';
		
		const input = document.createElement('input');
		input.type = 'hidden';
		input.name = 'groupId';
		input.value = groupId;
		form.appendChild(input);
		
		document.body.appendChild(form);
		form.submit();
		document.body.removeChild(form);
		
		// Start timer if there's a time limit
		if (event.maxPresentationTime) {
			startTimer(event.maxPresentationTime);
		}
	}
	
	function startTimer() {
		if (timerRunning) return;
		timerRunning = true;
		timerInterval = setInterval(() => {
			if (timerSeconds === 0) {
				if (timerMinutes === 0) {
					stopTimer();
					// Timer ended!
					alert('Time is up!');
					return;
				}
				timerMinutes--;
				timerSeconds = 59;
			} else {
				timerSeconds--;
			}
		}, 1000);
	}
	
	function pauseTimer() {
		timerRunning = false;
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
	}
	
	function stopTimer() {
		pauseTimer();
		timerMinutes = data.event.maxPresentationTime || 5;
		timerSeconds = 0;
	}
	
	function nextGroup() {
		if (currentGroupIndex < groups.length - 1) {
			stopTimer();
			currentGroupIndex++;
		}
	}
	
	function previousGroup() {
		if (currentGroupIndex > 0) {
			stopTimer();
			currentGroupIndex--;
		}
	}
	
	function openVoting() {
		// Will implement voting in next step
		if (confirm('Open voting for this presentation?')) {
			// Update status to voting
		}
	}
	
	function endEvent() {
		if (confirm('Are you sure you want to end the event?')) {
			goto(`/event/${event.id}`);
		}
	}
</script>

<ParticleBackground />

<div class="relative min-h-screen p-4 md:p-8 bg-gradient-to-br from-purple-400/50 via-pink-400/50 to-blue-400/50 animate-gradient overflow-hidden">
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
	
	<style>
		@keyframes gradient {
			0%, 100% { background-position: 0% 50%; }
			50% { background-position: 100% 50%; }
		}
		.animate-gradient {
			background-size: 200% 200%;
			animation: gradient 8s ease infinite;
		}
	</style>
	<div class="max-w-7xl mx-auto">
		<!-- Header -->
		<div class="mb-8 flex justify-between items-center glass-bright rounded-2xl p-6 border-2 border-purple-400/30">
			<div>
				<h1 class="text-4xl font-bold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400">
					🔴 {event.name} - LIVE
				</h1>
				<p class="text-purple-200 font-semibold">Host Controls</p>
			</div>
			<button 
				onclick={endEvent}
				class="px-6 py-3 bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white rounded-lg font-semibold transition shadow-lg border border-red-400"
			>
				End Event
			</button>
		</div>

		{#if groups.length === 0}
			<div class="glass-bright-strong rounded-xl p-12 shadow-2xl border-2 border-purple-400/40 text-center">
				<p class="text-xl text-gray-400 mb-4">No groups have submitted presentations yet.</p>
				<button 
					onclick={() => goto(`/event/${event.id}`)}
					class="px-6 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-semibold transition"
				>
					← Back to Event Settings
				</button>
			</div>
		{:else}
			<div class="grid lg:grid-cols-3 gap-6">
				<!-- Main Presentation Area -->
				<div class="lg:col-span-2 space-y-6">
					<!-- Current Presenter -->
					<div class="glass-bright-strong rounded-2xl p-8 shadow-2xl border-4 border-purple-400/50 ring-2 ring-purple-300/30">
						<div class="text-center mb-6">
							<p class="text-sm text-gray-400 mb-2 uppercase tracking-wide">Now Presenting</p>
							<h2 class="text-4xl font-bold mb-4">
								{currentGroup.emoji || '📊'} {currentGroup.name}
							</h2>
							<p class="text-gray-400">
								Presentation {currentGroupIndex + 1} of {groups.length}
							</p>
						</div>

						<!-- Timer -->
						<div class="bg-theater-darker rounded-xl p-8 mb-6 border border-gray-700">
							<div class="text-center mb-6">
								<p class="text-sm text-gray-400 mb-2 uppercase tracking-wide">Timer</p>
								<div class="text-7xl font-bold font-mono {timerMinutes === 0 && timerSeconds < 30 ? 'text-red-400' : 'text-white'}">
									{String(timerMinutes).padStart(2, '0')}:{String(timerSeconds).padStart(2, '0')}
								</div>
							</div>
							
							<div class="flex gap-3 justify-center">
								{#if !timerRunning}
									<button 
										onclick={startTimer}
										class="px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition"
									>
										▶️ Start
									</button>
								{:else}
									<button 
										onclick={pauseTimer}
										class="px-6 py-3 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg font-semibold transition"
									>
										⏸️ Pause
									</button>
								{/if}
								<button 
									onclick={stopTimer}
									class="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition"
								>
									⏹️ Reset
								</button>
							</div>
						</div>

						<!-- Team Members -->
						<div class="mb-6">
							<p class="text-sm text-gray-400 mb-3 uppercase tracking-wide">Team Members</p>
							<div class="flex flex-wrap gap-2">
								{#each currentGroup.members as member}
									<span class="px-4 py-2 bg-theater-darker rounded-lg border border-gray-700 text-white">
										{#if member.isLeader}👑{/if} {member.user.name}
									</span>
								{/each}
							</div>
						</div>

						<!-- Presentation Link -->
						{#if currentGroup.submissionLink}
							<div class="mb-6">
								<p class="text-sm text-gray-400 mb-2 uppercase tracking-wide">Presentation Link</p>
								<a 
									href={currentGroup.submissionLink}
									target="_blank"
									class="text-blue-400 hover:text-blue-300 underline break-all"
								>
									{currentGroup.submissionLink}
								</a>
							</div>
						{/if}

						<!-- Navigation -->
						<div class="flex gap-3 justify-between pt-6 border-t border-gray-700">
							<button 
								onclick={previousGroup}
								disabled={currentGroupIndex === 0}
								class="px-6 py-3 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition"
							>
								← Previous
							</button>
							<button 
								onclick={openVoting}
								class="px-8 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-semibold transition"
							>
								⭐ Open Voting
							</button>
							<button 
								onclick={nextGroup}
								disabled={currentGroupIndex === groups.length - 1}
								class="px-6 py-3 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition"
							>
								Next →
							</button>
						</div>
					</div>
				</div>

				<!-- Sidebar -->
				<div class="space-y-6">
					<!-- Lineup -->
					<div class="glass-bright rounded-2xl p-6 shadow-xl border-2 border-purple-400/30">
						<h3 class="text-xl font-semibold mb-4 text-purple-100">Presentation Lineup</h3>
						<div class="space-y-2 max-h-[600px] overflow-y-auto">
							{#each groups as group, index}
								<button
									onclick={() => {
										stopTimer();
										currentGroupIndex = index;
									}}
									class="w-full text-left p-4 rounded-lg transition border-2
										{index === currentGroupIndex 
											? 'bg-theater-purple border-theater-purple text-white' 
											: 'bg-theater-darker border-gray-700 hover:border-gray-600'}"
								>
									<div class="flex items-center justify-between mb-1">
										<span class="font-semibold">
											{group.emoji || '📊'} {group.name}
										</span>
										{#if index === currentGroupIndex}
											<span class="text-xs px-2 py-1 bg-white/20 rounded">NOW</span>
										{/if}
									</div>
									<p class="text-xs text-gray-400">
										{group.members.length} member{group.members.length !== 1 ? 's' : ''}
									</p>
								</button>
							{/each}
						</div>
					</div>

					<!-- Event Status -->
					<div class="glass-bright rounded-2xl p-6 shadow-xl border-2 border-purple-400/30">
						<h3 class="text-xl font-semibold mb-4 text-purple-100">Event Status</h3>
						<div class="space-y-3 text-sm">
							<div class="flex justify-between">
								<span class="text-gray-400">Status</span>
								<span class="font-semibold text-red-400">🔴 Live</span>
							</div>
							<div class="flex justify-between">
								<span class="text-gray-400">Total Groups</span>
								<span class="font-semibold">{groups.length}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-gray-400">Current</span>
								<span class="font-semibold">{currentGroupIndex + 1} of {groups.length}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-gray-400">Remaining</span>
								<span class="font-semibold">{groups.length - currentGroupIndex - 1}</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	@keyframes float-random {
		0%, 100% {
			transform: translate(0, 0) rotate(0deg);
		}
		25% {
			transform: translate(40px, -30px) rotate(120deg);
		}
		50% {
			transform: translate(-20px, 40px) rotate(240deg);
		}
		75% {
			transform: translate(30px, 20px) rotate(180deg);
		}
	}
	
	.animate-float-random {
		animation: float-random linear infinite;
		will-change: transform;
	}
</style>
