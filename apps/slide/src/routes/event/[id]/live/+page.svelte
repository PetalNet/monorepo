<script lang="ts">
	import { enhance } from "$app/forms";
	import { goto } from "$app/navigation";
	import { invalidateAll } from "$app/navigation";
	import ParticleBackground from "$lib/components/ParticleBackground.svelte";
	import QRCode from "qrcode";
	import { onMount, onDestroy } from "svelte";

	const { data } = $props();
	const event = $derived(data.event);
	const orderedGroups = $derived(data.orderedGroups);
	const isHost = $derived(data.isHost);
	const votingSession = $derived(data.votingSession);
	const currentUser = $derived(data.currentUser);

	let qrCodeUrl = $state("");
	let showJoinModal = $state(false);
	let displayName = $state("");
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
		type: "circle" | "square" | "triangle";
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
		const colors = [
			"rgb(168 85 247 / 0.15)",
			"rgb(236 72 153 / 0.15)",
			"rgb(147 197 253 / 0.15)",
			"rgb(129 140 248 / 0.15)",
		];
		const types: ("circle" | "square" | "triangle")[] = [
			"circle",
			"circle",
			"square",
			"square",
			"triangle",
		];
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
				duration: 18 + i * 3,
			});
		}

		backgroundShapes = shapes;
	}

	// Get voting URL
	const votingUrl = $derived(() => {
		if (typeof window === "undefined") return "";
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
		return `${mins}:${secs.toString().padStart(2, "0")}`;
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
				console.error("Failed to generate QR code:", err);
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
		const form = document.createElement("form");
		form.method = "POST";
		form.action = "?/setCurrentPresentation";

		const input = document.createElement("input");
		input.type = "hidden";
		input.name = "groupId";
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
					alert("Time is up!");
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
		if (confirm("Open voting for this presentation?")) {
			// Update status to voting
		}
	}

	function endEvent() {
		if (confirm("Are you sure you want to end the event?")) {
			goto(`/event/${event.id}`);
		}
	}
</script>

<ParticleBackground />

<div
	class="animate-gradient relative min-h-screen overflow-hidden bg-gradient-to-br from-purple-400/50 via-pink-400/50 to-blue-400/50 p-4 md:p-8"
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
	</style>
	<div class="mx-auto max-w-7xl">
		<!-- Header -->
		<div
			class="glass-bright mb-8 flex items-center justify-between rounded-2xl border-2 border-purple-400/30 p-6"
		>
			<div>
				<h1
					class="mb-2 bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400 bg-clip-text text-4xl font-bold text-transparent"
				>
					🔴 {event.name} - LIVE
				</h1>
				<p class="font-semibold text-purple-200">Host Controls</p>
			</div>
			<button
				onclick={endEvent}
				class="rounded-lg border border-red-400 bg-gradient-to-r from-red-500 to-red-600 px-6 py-3 font-semibold text-white shadow-lg transition hover:from-red-600 hover:to-red-700"
			>
				End Event
			</button>
		</div>

		{#if groups.length === 0}
			<div
				class="glass-bright-strong rounded-xl border-2 border-purple-400/40 p-12 text-center shadow-2xl"
			>
				<p class="mb-4 text-xl text-gray-400">No groups have submitted presentations yet.</p>
				<button
					onclick={() => goto(`/event/${event.id}`)}
					class="rounded-lg bg-theater-purple px-6 py-3 font-semibold text-white transition hover:bg-purple-600"
				>
					← Back to Event Settings
				</button>
			</div>
		{:else}
			<div class="grid gap-6 lg:grid-cols-3">
				<!-- Main Presentation Area -->
				<div class="space-y-6 lg:col-span-2">
					<!-- Current Presenter -->
					<div
						class="glass-bright-strong rounded-2xl border-4 border-purple-400/50 p-8 shadow-2xl ring-2 ring-purple-300/30"
					>
						<div class="mb-6 text-center">
							<p class="mb-2 text-sm uppercase tracking-wide text-gray-400">Now Presenting</p>
							<h2 class="mb-4 text-4xl font-bold">
								{currentGroup.emoji || "📊"}
								{currentGroup.name}
							</h2>
							<p class="text-gray-400">
								Presentation {currentGroupIndex + 1} of {groups.length}
							</p>
						</div>

						<!-- Timer -->
						<div class="mb-6 rounded-xl border border-gray-700 bg-theater-darker p-8">
							<div class="mb-6 text-center">
								<p class="mb-2 text-sm uppercase tracking-wide text-gray-400">Timer</p>
								<div
									class="font-mono text-7xl font-bold {timerMinutes === 0 && timerSeconds < 30
										? 'text-red-400'
										: 'text-white'}"
								>
									{String(timerMinutes).padStart(2, "0")}:{String(timerSeconds).padStart(2, "0")}
								</div>
							</div>

							<div class="flex justify-center gap-3">
								{#if !timerRunning}
									<button
										onclick={startTimer}
										class="rounded-lg bg-green-600 px-6 py-3 font-semibold text-white transition hover:bg-green-700"
									>
										▶️ Start
									</button>
								{:else}
									<button
										onclick={pauseTimer}
										class="rounded-lg bg-yellow-600 px-6 py-3 font-semibold text-white transition hover:bg-yellow-700"
									>
										⏸️ Pause
									</button>
								{/if}
								<button
									onclick={stopTimer}
									class="rounded-lg bg-red-600 px-6 py-3 font-semibold text-white transition hover:bg-red-700"
								>
									⏹️ Reset
								</button>
							</div>
						</div>

						<!-- Team Members -->
						<div class="mb-6">
							<p class="mb-3 text-sm uppercase tracking-wide text-gray-400">Team Members</p>
							<div class="flex flex-wrap gap-2">
								{#each currentGroup.members as member}
									<span
										class="rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white"
									>
										{#if member.isLeader}👑{/if}
										{member.user.name}
									</span>
								{/each}
							</div>
						</div>

						<!-- Presentation Link -->
						{#if currentGroup.submissionLink}
							<div class="mb-6">
								<p class="mb-2 text-sm uppercase tracking-wide text-gray-400">Presentation Link</p>
								<a
									href={currentGroup.submissionLink}
									target="_blank"
									class="break-all text-blue-400 underline hover:text-blue-300"
								>
									{currentGroup.submissionLink}
								</a>
							</div>
						{/if}

						<!-- Navigation -->
						<div class="flex justify-between gap-3 border-t border-gray-700 pt-6">
							<button
								onclick={previousGroup}
								disabled={currentGroupIndex === 0}
								class="rounded-lg bg-gray-700 px-6 py-3 font-semibold text-white transition hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
							>
								← Previous
							</button>
							<button
								onclick={openVoting}
								class="rounded-lg bg-theater-purple px-8 py-3 font-semibold text-white transition hover:bg-purple-600"
							>
								⭐ Open Voting
							</button>
							<button
								onclick={nextGroup}
								disabled={currentGroupIndex === groups.length - 1}
								class="rounded-lg bg-gray-700 px-6 py-3 font-semibold text-white transition hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
							>
								Next →
							</button>
						</div>
					</div>
				</div>

				<!-- Sidebar -->
				<div class="space-y-6">
					<!-- Lineup -->
					<div class="glass-bright rounded-2xl border-2 border-purple-400/30 p-6 shadow-xl">
						<h3 class="mb-4 text-xl font-semibold text-purple-100">Presentation Lineup</h3>
						<div class="max-h-[600px] space-y-2 overflow-y-auto">
							{#each groups as group, index}
								<button
									onclick={() => {
										stopTimer();
										currentGroupIndex = index;
									}}
									class="w-full rounded-lg border-2 p-4 text-left transition
										{index === currentGroupIndex
										? 'border-theater-purple bg-theater-purple text-white'
										: 'border-gray-700 bg-theater-darker hover:border-gray-600'}"
								>
									<div class="mb-1 flex items-center justify-between">
										<span class="font-semibold">
											{group.emoji || "📊"}
											{group.name}
										</span>
										{#if index === currentGroupIndex}
											<span class="rounded bg-white/20 px-2 py-1 text-xs">NOW</span>
										{/if}
									</div>
									<p class="text-xs text-gray-400">
										{group.members.length} member{group.members.length !== 1 ? "s" : ""}
									</p>
								</button>
							{/each}
						</div>
					</div>

					<!-- Event Status -->
					<div class="glass-bright rounded-2xl border-2 border-purple-400/30 p-6 shadow-xl">
						<h3 class="mb-4 text-xl font-semibold text-purple-100">Event Status</h3>
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
		0%,
		100% {
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
