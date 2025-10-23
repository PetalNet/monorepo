<script lang="ts"><script lang="ts">

	import { enhance } from '$app/forms';	import { enhance } from '$app/forms';

	import { invalidateAll } from '$app/navigation';	import { goto } from '$app/navigation';

	import { onMount, onDestroy } from 'svelte';	import { invalidateAll } from '$app/navigation';

	import QRCode from 'qrcode';	import { onMount, onDestroy } from 'svelte';

		import QRCode from 'qrcode';

	const { data } = $props();	

	const { event, orderedGroups, isHost, votingSession, currentUser } = data;	const { data } = $props();

		const { event, orderedGroups, isHost, votingSession, currentUser } = data;

	let qrCodeUrl = $state('');	

	let showJoinModal = $state(false);	let qrCodeUrl = $state('');

	let displayName = $state('');	let showJoinModal = $state(false);

	let timerSeconds = $state(0);	let displayName = $state('');

	let timerRunning = $state(false);	let currentPresentationIndex = $state(0);

	let timerInterval: ReturnType<typeof setInterval> | null = null;	let timerSeconds = $state(0);

	let ratings = $state<Record<string, number>>({});	let timerRunning = $state(false);

	let hoveredStars = $state<Record<string, number>>({});	let timerInterval: ReturnType<typeof setInterval> | null = null;

	let hasVotedForCurrent = $state(false);	let ratings = $state<Record<string, number>>({});

	let pollInterval: ReturnType<typeof setInterval> | null = null;	let hoveredStars = $state<Record<string, number>>({});

		let hasVotedForCurrent = $state(false);

	// Get voting URL	let pollInterval: ReturnType<typeof setInterval> | null = null;

	const votingUrl = $derived(() => {	

		if (typeof window === 'undefined') return '';	// Get voting URL

		return `${window.location.origin}/event/${event.id}/live`;	const votingUrl = $derived(() => {

	});		if (typeof window === 'undefined') return '';

			return `${window.location.origin}/event/${event.id}/live`;

	// Current presentation	});

	const currentPresentation = $derived(() => {	

		if (!event.currentPresentationId) return null;	// Current presentation

		return orderedGroups.find((g: any) => g.id === event.currentPresentationId);	const currentPresentation = $derived(() => {

	});		if (!event.currentPresentationId) return null;

			return orderedGroups.find((g: any) => g.id === event.currentPresentationId);

	// Check if user can vote	});

	const canVote = $derived(!!votingSession || !!currentUser);	

		// Check if user can vote

	// Format timer display	const canVote = $derived(!!votingSession || !!currentUser);

	const timerDisplay = $derived(() => {	

		const mins = Math.floor(timerSeconds / 60);	// Format timer display

		const secs = timerSeconds % 60;	const timerDisplay = $derived(() => {

		return `${mins}:${secs.toString().padStart(2, '0')}`;		const mins = Math.floor(timerSeconds / 60);

	});		const secs = timerSeconds % 60;

			return `${mins}:${secs.toString().padStart(2, '0')}`;

	// Initialize ratings for current presentation	});

	$effect(() => {	

		if (currentPresentation) {	// Initialize ratings for current presentation

			const newRatings: Record<string, number> = {};	$effect(() => {

			event.categories.forEach((cat: any) => {		if (currentPresentation) {

				newRatings[cat.id] = ratings[cat.id] || 0;			const newRatings: Record<string, number> = {};

			});			event.categories.forEach((cat: any) => {

			ratings = newRatings;				newRatings[cat.id] = ratings[cat.id] || 0;

			hasVotedForCurrent = false;			});

		}			ratings = newRatings;

	});			hasVotedForCurrent = false;

			}

	onMount(async () => {	});

		// Generate QR code	

		if (isHost) {	onMount(async () => {

			try {		// Generate QR code

				qrCodeUrl = await QRCode.toDataURL(votingUrl());		if (isHost) {

			} catch (err) {			try {

				console.error('Failed to generate QR code:', err);				qrCodeUrl = await QRCode.toDataURL(votingUrl());

			}			} catch (err) {

		}				console.error('Failed to generate QR code:', err);

					}

		// Poll for updates every 3 seconds		}

		pollInterval = setInterval(() => {		

			invalidateAll();		// Poll for updates every 3 seconds

		}, 3000);		pollInterval = setInterval(() => {

	});			invalidateAll();

			}, 3000);

	onDestroy(() => {	});

		if (timerInterval) clearInterval(timerInterval);	

		if (pollInterval) clearInterval(pollInterval);	onDestroy(() => {

	});		if (timerInterval) clearInterval(timerInterval);

			if (pollInterval) clearInterval(pollInterval);

	function startPresentation(groupId: string) {	});

		// Set current presentation via form action	

		const form = document.createElement('form');	function startPresentation(groupId: string, index: number) {

		form.method = 'POST';		currentPresentationIndex = index;

		form.action = '?/setCurrentPresentation';		

				// Set current presentation via form action

		const input = document.createElement('input');		const form = document.createElement('form');

		input.type = 'hidden';		form.method = 'POST';

		input.name = 'groupId';		form.action = '?/setCurrentPresentation';

		input.value = groupId;		

		form.appendChild(input);		const input = document.createElement('input');

				input.type = 'hidden';

		document.body.appendChild(form);		input.name = 'groupId';

		form.requestSubmit();		input.value = groupId;

		document.body.removeChild(form);		form.appendChild(input);

				

		// Start timer if there's a time limit		document.body.appendChild(form);

		if (event.maxPresentationTime) {		form.submit();

			startTimer(event.maxPresentationTime);		document.body.removeChild(form);

		}		

	}		// Start timer if there's a time limit

			if (event.maxPresentationTime) {

	function startTimer(minutes: number) {			startTimer(event.maxPresentationTime);

		stopTimer();		}

		timerSeconds = minutes * 60;	}

		timerRunning = true;	

			function startTimer() {

		timerInterval = setInterval(() => {		if (timerRunning) return;

			if (timerSeconds > 0) {		timerRunning = true;

				timerSeconds--;		timerInterval = setInterval(() => {

			} else {			if (timerSeconds === 0) {

				stopTimer();				if (timerMinutes === 0) {

				if (typeof window !== 'undefined') {					stopTimer();

					alert('Time is up!');					// Timer ended!

				}					alert('Time is up!');

			}					return;

		}, 1000);				}

	}				timerMinutes--;

					timerSeconds = 59;

	function pauseTimer() {			} else {

		timerRunning = false;				timerSeconds--;

		if (timerInterval) {			}

			clearInterval(timerInterval);		}, 1000);

			timerInterval = null;	}

		}	

	}	function pauseTimer() {

			timerRunning = false;

	function stopTimer() {		if (timerInterval) {

		pauseTimer();			clearInterval(timerInterval);

		timerSeconds = 0;			timerInterval = null;

	}		}

		}

	function nextPresentation() {	

		const currentIdx = orderedGroups.findIndex((g: any) => g.id === event.currentPresentationId);	function stopTimer() {

		if (currentIdx < orderedGroups.length - 1) {		pauseTimer();

			startPresentation(orderedGroups[currentIdx + 1].id);		timerMinutes = data.event.maxPresentationTime || 5;

		}		timerSeconds = 0;

	}	}

		

	function previousPresentation() {	function nextGroup() {

		const currentIdx = orderedGroups.findIndex((g: any) => g.id === event.currentPresentationId);		if (currentGroupIndex < groups.length - 1) {

		if (currentIdx > 0) {			stopTimer();

			startPresentation(orderedGroups[currentIdx - 1].id);			currentGroupIndex++;

		}		}

	}	}

		

	function endPresentation() {	function previousGroup() {

		stopTimer();		if (currentGroupIndex > 0) {

		// Clear current presentation			stopTimer();

		const form = document.createElement('form');			currentGroupIndex--;

		form.method = 'POST';		}

		form.action = '?/setCurrentPresentation';	}

			

		const input = document.createElement('input');	function openVoting() {

		input.type = 'hidden';		// Will implement voting in next step

		input.name = 'groupId';		if (confirm('Open voting for this presentation?')) {

		input.value = '';			// Update status to voting

		form.appendChild(input);		}

			}

		document.body.appendChild(form);	

		form.requestSubmit();	function endEvent() {

		document.body.removeChild(form);		if (confirm('Are you sure you want to end the event?')) {

	}			goto(`/event/${event.id}`);

			}

	function setRating(categoryId: string, stars: number) {	}

		ratings = { ...ratings, [categoryId]: stars };</script>

	}

	<div class="min-h-screen p-4 md:p-8 bg-theater-darker">

	function setHoveredStars(categoryId: string, stars: number) {	<div class="max-w-7xl mx-auto">

		hoveredStars = { ...hoveredStars, [categoryId]: stars };		<!-- Header -->

	}		<div class="mb-8 flex justify-between items-center">

				<div>

	function clearHoveredStars(categoryId: string) {				<h1 class="text-4xl font-bold mb-2">🔴 {event.name} - LIVE</h1>

		const { [categoryId]: _, ...rest } = hoveredStars;				<p class="text-gray-400">Host Controls</p>

		hoveredStars = rest;			</div>

	}			<button 

</script>				onclick={endEvent}

				class="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition"

<div class="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900">			>

	<!-- Start Screen / Join Screen -->				End Event

	{#if !currentPresentation && !votingSession}			</button>

		<div class="min-h-screen flex items-center justify-center p-8">		</div>

			<div class="bg-white/10 backdrop-blur-xl rounded-3xl p-12 max-w-2xl w-full border border-white/20 shadow-2xl">

				<h1 class="text-5xl font-bold text-white mb-8 text-center">		{#if groups.length === 0}

					{event.name}			<div class="bg-theater-dark rounded-xl p-12 shadow-lg border border-gray-800 text-center">

				</h1>				<p class="text-xl text-gray-400 mb-4">No groups have submitted presentations yet.</p>

								<button 

				{#if isHost}					onclick={() => goto(`/event/${event.id}`)}

					<div class="mb-12">					class="px-6 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-semibold transition"

						<h2 class="text-2xl font-semibold text-white mb-6 text-center">				>

							Scan to Join & Vote					← Back to Event Settings

						</h2>				</button>

									</div>

						{#if qrCodeUrl}		{:else}

							<div class="bg-white rounded-2xl p-8 mb-6 flex justify-center">			<div class="grid lg:grid-cols-3 gap-6">

								<img src={qrCodeUrl} alt="Join QR Code" class="w-64 h-64" />				<!-- Main Presentation Area -->

							</div>				<div class="lg:col-span-2 space-y-6">

						{/if}					<!-- Current Presenter -->

											<div class="bg-theater-dark rounded-xl p-8 shadow-lg border-2 border-theater-purple">

						<div class="bg-white/20 rounded-xl p-4 mb-8">						<div class="text-center mb-6">

							<p class="text-white text-center font-mono text-lg break-all">							<p class="text-sm text-gray-400 mb-2 uppercase tracking-wide">Now Presenting</p>

								{votingUrl()}							<h2 class="text-4xl font-bold mb-4">

							</p>								{currentGroup.emoji || '📊'} {currentGroup.name}

						</div>							</h2>

													<p class="text-gray-400">

						<p class="text-white/80 text-center mb-8">								Presentation {currentGroupIndex + 1} of {groups.length}

							Voters can scan the QR code or visit the link to join							</p>

						</p>						</div>

					</div>

											<!-- Timer -->

					<div class="space-y-4">						<div class="bg-theater-darker rounded-xl p-8 mb-6 border border-gray-700">

						<h3 class="text-xl font-semibold text-white mb-4">Host Controls</h3>							<div class="text-center mb-6">

														<p class="text-sm text-gray-400 mb-2 uppercase tracking-wide">Timer</p>

						{#if orderedGroups.length > 0}								<div class="text-7xl font-bold font-mono {timerMinutes === 0 && timerSeconds < 30 ? 'text-red-400' : 'text-white'}">

							<button									{String(timerMinutes).padStart(2, '0')}:{String(timerSeconds).padStart(2, '0')}

								onclick={() => startPresentation(orderedGroups[0].id)}								</div>

								class="w-full py-4 bg-green-600 hover:bg-green-700 text-white rounded-xl font-semibold text-lg transition-all transform hover:scale-105 shadow-lg"							</div>

							>							

								🎬 Start First Presentation							<div class="flex gap-3 justify-center">

							</button>								{#if !timerRunning}

						{:else}									<button 

							<div class="bg-yellow-500/20 border border-yellow-500/50 rounded-xl p-6 text-center">										onclick={startTimer}

								<p class="text-white">										class="px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition"

									No presentations submitted yet. Waiting for groups to submit...									>

								</p>										▶️ Start

							</div>									</button>

						{/if}								{:else}

					</div>									<button 

				{:else}										onclick={pauseTimer}

					<div class="text-center">										class="px-6 py-3 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg font-semibold transition"

						<p class="text-white text-xl mb-8">									>

							Welcome! Join as a voter to rate presentations.										⏸️ Pause

						</p>									</button>

														{/if}

						<button								<button 

							onclick={() => showJoinModal = true}									onclick={stopTimer}

							class="px-8 py-4 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-semibold text-lg transition-all transform hover:scale-105 shadow-lg"									class="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition"

						>								>

							Join as Voter									⏹️ Reset

						</button>								</button>

					</div>							</div>

				{/if}						</div>

			</div>

		</div>						<!-- Team Members -->

	{/if}						<div class="mb-6">

								<p class="text-sm text-gray-400 mb-3 uppercase tracking-wide">Team Members</p>

	<!-- Active Presentation Screen -->							<div class="flex flex-wrap gap-2">

	{#if currentPresentation}								{#each currentGroup.members as member}

		<div class="min-h-screen p-8">									<span class="px-4 py-2 bg-theater-darker rounded-lg border border-gray-700 text-white">

			<div class="max-w-6xl mx-auto">										{#if member.isLeader}👑{/if} {member.user.name}

				<!-- Header with Timer -->									</span>

				<div class="bg-white/10 backdrop-blur-xl rounded-2xl p-6 mb-8 border border-white/20 shadow-xl">								{/each}

					<div class="flex justify-between items-center">							</div>

						<div>						</div>

							<h2 class="text-3xl font-bold text-white mb-2">

								{currentPresentation.name}						<!-- Presentation Link -->

							</h2>						{#if currentGroup.submissionLink}

							<p class="text-white/70">							<div class="mb-6">

								Presented by: {currentPresentation.members.map((m: any) => m.user.name).join(', ')}								<p class="text-sm text-gray-400 mb-2 uppercase tracking-wide">Presentation Link</p>

							</p>								<a 

						</div>									href={currentGroup.submissionLink}

															target="_blank"

						{#if event.maxPresentationTime && timerSeconds > 0}									class="text-blue-400 hover:text-blue-300 underline break-all"

							<div class="text-center">								>

								<div class="text-6xl font-bold text-white mb-2 font-mono">									{currentGroup.submissionLink}

									{timerDisplay()}								</a>

								</div>							</div>

								<p class="text-white/70">Time Remaining</p>						{/if}

							</div>

						{/if}						<!-- Navigation -->

					</div>						<div class="flex gap-3 justify-between pt-6 border-t border-gray-700">

				</div>							<button 

												onclick={previousGroup}

				<!-- Voting Section -->								disabled={currentGroupIndex === 0}

				{#if canVote}								class="px-6 py-3 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition"

					<div class="bg-white/10 backdrop-blur-xl rounded-2xl p-8 mb-8 border border-white/20 shadow-xl">							>

						<h3 class="text-2xl font-bold text-white mb-6 text-center">								← Previous

							Rate This Presentation							</button>

						</h3>							<button 

														onclick={openVoting}

						{#if !hasVotedForCurrent}								class="px-8 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-semibold transition"

							<form							>

								method="POST"								⭐ Open Voting

								action="?/submitVote{votingSession ? `&session=${votingSession.sessionCode}` : ''}"							</button>

								use:enhance={() => {							<button 

									return async ({ result }) => {								onclick={nextGroup}

										if (result.type === 'success') {								disabled={currentGroupIndex === groups.length - 1}

											hasVotedForCurrent = true;								class="px-6 py-3 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition"

											setTimeout(() => {							>

												invalidateAll();								Next →

											}, 500);							</button>

										}						</div>

									};					</div>

								}}				</div>

							>

								<input type="hidden" name="groupId" value={currentPresentation.id} />				<!-- Sidebar -->

								<input type="hidden" name="ratings" value={JSON.stringify(				<div class="space-y-6">

									event.categories.map((cat: any) => ({					<!-- Lineup -->

										categoryId: cat.id,					<div class="bg-theater-dark rounded-xl p-6 shadow-lg border border-gray-800">

										stars: ratings[cat.id] || 0						<h3 class="text-xl font-semibold mb-4">Presentation Lineup</h3>

									}))						<div class="space-y-2 max-h-[600px] overflow-y-auto">

								)} />							{#each groups as group, index}

																<button

								<div class="space-y-6 mb-8">									onclick={() => {

									{#each event.categories as category}										stopTimer();

										<div class="bg-white/5 rounded-xl p-6">										currentGroupIndex = index;

											<h4 class="text-xl font-semibold text-white mb-4">									}}

												{category.name}									class="w-full text-left p-4 rounded-lg transition border-2

											</h4>										{index === currentGroupIndex 

											{#if category.description}											? 'bg-theater-purple border-theater-purple text-white' 

												<p class="text-white/60 text-sm mb-4">{category.description}</p>											: 'bg-theater-darker border-gray-700 hover:border-gray-600'}"

											{/if}								>

																				<div class="flex items-center justify-between mb-1">

											<div class="flex gap-2 justify-center">										<span class="font-semibold">

												{#each [1, 2, 3, 4, 5] as star}											{group.emoji || '📊'} {group.name}

													<button										</span>

														type="button"										{#if index === currentGroupIndex}

														onclick={() => setRating(category.id, star)}											<span class="text-xs px-2 py-1 bg-white/20 rounded">NOW</span>

														onmouseenter={() => setHoveredStars(category.id, star)}										{/if}

														onmouseleave={() => clearHoveredStars(category.id)}									</div>

														class="transition-all transform hover:scale-125"									<p class="text-xs text-gray-400">

													>										{group.members.length} member{group.members.length !== 1 ? 's' : ''}

														<svg									</p>

															class="w-12 h-12 transition-all duration-200"								</button>

															fill={(hoveredStars[category.id] || ratings[category.id] || 0) >= star ? '#FFD700' : 'none'}							{/each}

															stroke={(hoveredStars[category.id] || ratings[category.id] || 0) >= star ? '#FFD700' : '#FFFFFF'}						</div>

															stroke-width="2"					</div>

															viewBox="0 0 24 24"

														>					<!-- Event Status -->

															<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />					<div class="bg-theater-dark rounded-xl p-6 shadow-lg border border-gray-800">

														</svg>						<h3 class="text-xl font-semibold mb-4">Event Status</h3>

													</button>						<div class="space-y-3 text-sm">

												{/each}							<div class="flex justify-between">

											</div>								<span class="text-gray-400">Status</span>

										</div>								<span class="font-semibold text-red-400">🔴 Live</span>

									{/each}							</div>

								</div>							<div class="flex justify-between">

																<span class="text-gray-400">Total Groups</span>

								<button								<span class="font-semibold">{groups.length}</span>

									type="submit"							</div>

									disabled={Object.values(ratings).some(r => r === 0)}							<div class="flex justify-between">

									class="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed text-white rounded-xl font-semibold text-lg transition-all transform hover:scale-105 shadow-lg"								<span class="text-gray-400">Current</span>

								>								<span class="font-semibold">{currentGroupIndex + 1} of {groups.length}</span>

									Submit Vote							</div>

								</button>							<div class="flex justify-between">

							</form>								<span class="text-gray-400">Remaining</span>

						{:else}								<span class="font-semibold">{groups.length - currentGroupIndex - 1}</span>

							<div class="bg-green-500/20 border border-green-500/50 rounded-xl p-8 text-center">							</div>

								<svg class="w-16 h-16 text-green-400 mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">						</div>

									<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />					</div>

								</svg>				</div>

								<p class="text-white text-xl font-semibold">			</div>

									Vote Submitted! 🎉		{/if}

								</p>	</div>

								<p class="text-white/70 mt-2"></div>

									Thank you for voting on this presentation
								</p>
							</div>
						{/if}
					</div>
				{/if}
				
				<!-- Host Controls -->
				{#if isHost}
					<div class="bg-white/10 backdrop-blur-xl rounded-2xl p-6 border border-white/20 shadow-xl">
						<h3 class="text-xl font-bold text-white mb-4">Host Controls</h3>
						
						<div class="flex gap-4 flex-wrap">
							{#if event.maxPresentationTime}
								{#if timerRunning}
									<button
										onclick={pauseTimer}
										class="px-6 py-3 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg font-semibold transition"
									>
										⏸ Pause Timer
									</button>
								{:else if timerSeconds > 0}
									<button
										onclick={() => startTimer(Math.ceil(timerSeconds / 60))}
										class="px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition"
									>
										▶️ Resume Timer
									</button>
								{:else}
									<button
										onclick={() => startTimer(event.maxPresentationTime!)}
										class="px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition"
									>
										▶️ Start Timer
									</button>
								{/if}
								
								<button
									onclick={stopTimer}
									class="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition"
								>
									⏹ Stop Timer
								</button>
							{/if}
							
							<button
								onclick={previousPresentation}
								disabled={orderedGroups.findIndex((g: any) => g.id === event.currentPresentationId) === 0}
								class="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition"
							>
								⏮ Previous
							</button>
							
							<button
								onclick={nextPresentation}
								disabled={orderedGroups.findIndex((g: any) => g.id === event.currentPresentationId) === orderedGroups.length - 1}
								class="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition"
							>
								Next ⏭
							</button>
							
							<button
								onclick={endPresentation}
								class="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition ml-auto"
							>
								End Presentation
							</button>
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<!-- Join Modal -->
{#if showJoinModal && !votingSession}
	<div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
		<div class="bg-theater-dark rounded-xl p-8 max-w-md w-full border border-gray-700 shadow-2xl">
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
	@keyframes star-pulse {
		0%, 100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.2);
		}
	}
	
	button:active svg {
		animation: star-pulse 0.3s ease;
	}
</style>
