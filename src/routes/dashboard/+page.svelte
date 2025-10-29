<script lang="ts">
	import { goto } from '$app/navigation';
	import { formatDistanceToNow } from 'date-fns';
	import { formatRelativeWithTimezone, getTimezoneAbbr } from '$lib/utils/timezone';
	import { onMount } from 'svelte';
	import ParticleBackground from '$lib/components/ParticleBackground.svelte';
	
	let { data } = $props();
	let showContent = $state(false);

	onMount(() => {
		setTimeout(() => showContent = true, 100);
	});

	function getEventStatus(event: any) {
		if (event.status === 'completed') return { text: '✅ Completed', color: 'bg-green-900/50 text-green-200 border border-green-700/50', urgency: 'completed', showJoin: true };
		if (event.currentPresentationId) return { text: '🎬 Live Now', color: 'bg-red-900/50 text-red-200 border border-red-600/50 shadow-[0_0_20px_rgba(220,38,38,0.3)]', urgency: 'live', showJoin: true };
		return { text: '📝 Setup', color: 'bg-theater-elevated text-purple-200 border border-purple-700/30', urgency: 'setup', showJoin: false };
	}

	function getGroupStatus(group: any) {
		if (group.status === 'submitted') return { text: '✅ Submitted', color: 'bg-green-900/50 text-green-200 border border-green-700/50', urgency: 'done' };
		if (group.status === 'late') return { text: '⏰ Late', color: 'bg-red-900/50 text-red-200 border border-red-700/50', urgency: 'urgent' };
		return { text: '⏳ Pending', color: 'bg-amber-900/50 text-amber-200 border border-amber-700/50', urgency: 'warning' };
	}

	function nextDeadline(event: any) {
		const deadlines = event.groups?.map((g: any) => g.deadline ? new Date(g.deadline) : null).filter(Boolean) ?? [];
		if (!deadlines.length) return null;
		const future = deadlines.filter((d: any) => d && d > new Date());
		const soonest = (future.length ? future : deadlines).sort((a: any, b: any) => a.getTime() - b.getTime())[0];
		return soonest;
	}
</script>

<div class="min-h-screen bg-theater-background relative overflow-hidden">
	<ParticleBackground />
	
	<!-- Main content -->
	<div class="relative z-10 w-full max-w-6xl mx-auto px-2 sm:px-4 md:px-8 py-6 sm:py-8 md:py-12">
		<!-- Header & Quick Stats -->
		<div class={`flex flex-col gap-2 sm:gap-3 mb-6 sm:mb-10 transition-all duration-700 items-center ${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'} animate-fade-in animate-slide-up`}>
			<h1 class="text-center text-3xl sm:text-4xl md:text-5xl font-extrabold mb-1
				bg-gradient-to-r from-theater-purple via-theater-teal to-theater-gold bg-clip-text text-transparent drop-shadow-glow">
				Welcome back, {data.user?.name || 'Presenter'}!
			</h1>
			<p class="text-base sm:text-lg md:text-xl text-gray-400 text-center">Your command center</p>
			<div class="flex gap-3 mt-2">
				<div class="bg-theater-elevated border border-theater-purple/30 rounded-xl px-4 py-2 text-center shadow-md">
					<div class="text-xl font-bold text-theater-purple">{data.hostedEvents.length}</div>
					<div class="text-xs text-gray-400">Events</div>
				</div>
				<div class="bg-theater-elevated border border-theater-teal/30 rounded-xl px-4 py-2 text-center shadow-md">
					<div class="text-xl font-bold text-theater-teal">{data.groupMemberships.length}</div>
					<div class="text-xs text-gray-400">Presentations</div>
				</div>
			</div>
		</div>

		<!-- Upcoming Deadlines Section -->
		{#if (() => {
			let deadlines: any[] = [];
			data.groupMemberships.forEach(m => {
				if (m.group.event.submissionDeadline) {
					const deadline = new Date(m.group.event.submissionDeadline);
					if (deadline > new Date()) {
						deadlines.push({
							type: 'presentation',
							name: m.group.name,
							emoji: m.group.emoji,
							eventName: m.group.event.name,
							deadline,
							status: m.group.status,
							link: `/night/${m.group.event.joinCode}`
						});
					}
				}
			});
			return deadlines.sort((a: any, b: any) => a.deadline.getTime() - b.deadline.getTime()).length > 0;
		})()}
			{@const upcomingDeadlines = (() => {
				let deadlines: any[] = [];
				data.groupMemberships.forEach(m => {
					if (m.group.event.submissionDeadline) {
						const deadline = new Date(m.group.event.submissionDeadline);
						if (deadline > new Date()) {
							deadlines.push({
								type: 'presentation',
								name: m.group.name,
								emoji: m.group.emoji,
								eventName: m.group.event.name,
								deadline,
								status: m.group.status,
								link: `/night/${m.group.event.joinCode}`
							});
						}
					}
				});
				return deadlines.sort((a: any, b: any) => a.deadline.getTime() - b.deadline.getTime());
			})()}
			<section class="mb-8 sm:mb-12">
				<h2 class="text-center text-2xl sm:text-3xl font-bold text-white mb-5">
					Upcoming Deadlines
				</h2>
				<div class="w-full flex justify-center px-4">
					<div class="flex flex-wrap justify-center gap-6 max-w-7xl">
						{#each upcomingDeadlines as item, i}
							<button
								onclick={() => goto(item.link)}
								class={`glass rounded-2xl sm:rounded-3xl p-5 sm:p-6 w-full min-w-[280px] flex-1 basis-[400px] max-w-2xl
									transition-all duration-500 flex items-center gap-4 sm:gap-5
									hover:border-theater-gold/60 hover:shadow-2xl hover:shadow-theater-gold/20 hover:scale-[1.02]
									hover:-translate-y-1 group
									${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'} animate-fade-in animate-slide-up`}
								style="transition-delay: {i * 50}ms"
							>
								<!-- Emoji -->
								<span class="text-5xl sm:text-6xl flex-shrink-0 group-hover:scale-110 transition-transform duration-300">{item.emoji || '📑'}</span>
								
								<!-- Main content -->
								<div class="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
									<!-- Title section -->
									<div class="flex-1 min-w-0">
										<h3 class="text-lg sm:text-xl font-extrabold break-words leading-tight mb-1 relative">
											<span class="text-white transition-opacity duration-300 group-hover:opacity-0">
												{item.name}
											</span>
											<span class="absolute inset-0 bg-gradient-to-r from-theater-gold to-theater-teal bg-clip-text text-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100">
												{item.name}
											</span>
										</h3>
										<p class="text-sm text-gray-400 truncate">{item.eventName}</p>
									</div>
									
									<!-- Deadline -->
									<div class="flex items-center gap-3 flex-shrink-0">
										<div class="text-right">
											<p class="text-base sm:text-lg text-theater-gold font-extrabold whitespace-nowrap">
												{formatDistanceToNow(item.deadline, { addSuffix: true })}
											</p>
											<p class="text-xs text-gray-400">⏱️ Deadline</p>
										</div>
										{#if item.status === 'submitted'}
											<span class="text-sm px-3 py-1.5 rounded-xl bg-green-900/60 text-green-200 border-2 border-green-600/50 font-bold shadow-md">✅</span>
										{:else}
											<span class="text-sm px-3 py-1.5 rounded-xl bg-amber-900/60 text-amber-200 border-2 border-amber-600/50 font-bold shadow-md animate-pulse">⏳</span>
										{/if}
									</div>
								</div>
							</button>
						{/each}
					</div>
				</div>
			</section>
		{/if}

		<!-- Your Presentations Section -->
		<section class="mb-10 sm:mb-14">
			<h2 class="text-center text-2xl sm:text-3xl font-bold text-white mb-5">
				Your Presentations
			</h2>
			{#if data.groupMemberships.length === 0}
				<section class="w-full flex items-center justify-center py-20 sm:py-28">
					<div class="bg-theater-elevated border border-gray-800/50 rounded-2xl p-10 sm:p-16 shadow-xl text-center max-w-md mx-auto animate-fade-in animate-slide-up">
						<div class="text-6xl sm:text-7xl mb-6">📭</div>
						<p class="text-lg sm:text-xl text-gray-400">
							You're not part of any presentations yet.
						</p>
					</div>
				</section>
			{:else}
				<div class="w-full flex justify-center px-4">
					<div class="flex flex-wrap justify-center gap-6 max-w-7xl">
						{#each data.groupMemberships as membership, i}
							{@const eventStatus = getEventStatus(membership.group.event)}
							{@const groupStatus = getGroupStatus(membership.group)}
							<div class={`glass rounded-2xl sm:rounded-3xl p-5 sm:p-6 w-full min-w-[280px] flex-1 basis-[400px] max-w-2xl
								transition-all duration-500 flex flex-col gap-3
								hover:border-theater-teal/60 hover:shadow-2xl hover:shadow-theater-teal/20 hover:scale-[1.02]
								hover:-translate-y-1 group
								${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'} animate-fade-in animate-slide-up`}
							     style="transition-delay: {i * 50}ms">
								<button
									onclick={() => goto(`/night/${membership.group.event.joinCode}`)}
									class="text-left w-full flex items-center gap-4 sm:gap-5"
								>
									<!-- Emoji -->
									<span class="text-5xl sm:text-6xl flex-shrink-0 group-hover:scale-110 transition-transform duration-300">{membership.group.emoji || '📑'}</span>
									
									<!-- Main content -->
									<div class="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-3">
										<!-- Title and event -->
										<div class="flex-1 min-w-0">
											<h3 class="text-lg sm:text-xl font-extrabold break-words leading-tight mb-1 relative">
												<span class="text-white transition-opacity duration-300 group-hover:opacity-0">
													{membership.group.name}
												</span>
												<span class="absolute inset-0 bg-gradient-to-r from-theater-teal to-theater-purple bg-clip-text text-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100">
													{membership.group.name}
												</span>
											</h3>
											<p class="text-sm text-gray-400 truncate mb-2">
												{membership.group.event.name}
											</p>
											<div class="flex flex-wrap gap-2 text-xs text-gray-400">
												<span class="flex items-center gap-1">
													<span>👥</span> {membership.group.members?.length || 0}
												</span>
												{#if membership.isLeader}
													<span class="flex items-center gap-1 text-theater-gold font-bold">
														<span>⭐</span> Leader
													</span>
												{/if}
												{#if membership.group.event.submissionDeadline}
													<span class="flex items-center gap-1">
														<span>⏰</span> {formatRelativeWithTimezone(membership.group.event.submissionDeadline, membership.group.event.timezone)}
													</span>
												{/if}
											</div>
										</div>
										
										<!-- Status badges -->
										<div class="flex flex-wrap gap-2 flex-shrink-0">
											<span class={`text-sm px-3 py-1.5 rounded-xl font-bold ${groupStatus.color} whitespace-nowrap shadow-md`}>
												{groupStatus.text}
											</span>
											{#if eventStatus.showJoin}
												<span class={`text-sm px-3 py-1.5 rounded-xl font-bold ${eventStatus.color} whitespace-nowrap shadow-md`}>
													{eventStatus.text}
												</span>
											{/if}
										</div>
									</div>
								</button>
								
								{#if eventStatus.showJoin && eventStatus.urgency === 'live'}
									<button
										onclick={() => goto(`/night/${membership.group.event.joinCode}/live`)}
										class="w-full px-4 py-2.5 bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700 text-white rounded-xl font-extrabold text-sm transition-all shadow-xl shadow-red-900/50 flex items-center justify-center gap-2 hover:scale-105"
									>
										<span class="w-2 h-2 bg-white rounded-full animate-pulse"></span>
										Join Live Event
									</button>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</section>

		<!-- Your Events Section -->
		<section class="mb-8 sm:mb-14">
			<div class="flex flex-col sm:flex-row sm:items-center justify-center gap-4 mb-5 text-center">
				<h2 class="text-center text-2xl sm:text-3xl font-bold text-white">
					Your Events
				</h2>
				{#if data.hostedEvents.length > 0}
					<button
						onclick={() => goto('/event/create')}
						class="px-6 py-3 rounded-xl text-base font-bold bg-gradient-to-r from-theater-purple to-theater-gold text-white hover:from-theater-teal hover:to-theater-gold transition-all shadow-lg shadow-theater-purple/50 hover:scale-105 self-center"
					>
						+ Create Event
					</button>
				{/if}
			</div>
			{#if data.hostedEvents.length === 0}
				<section class="w-full flex items-center justify-center py-20 sm:py-28">
					<div class="bg-theater-elevated border border-gray-800/50 rounded-2xl p-10 sm:p-16 shadow-xl text-center max-w-md mx-auto animate-fade-in animate-slide-up">
						<div class="text-6xl sm:text-7xl mb-7">🎭</div>
						<p class="text-lg sm:text-xl text-gray-400 mb-7">
							You haven't created any events yet.
						</p>
						<button
							onclick={() => goto('/event/create')}
							class="px-8 py-4 rounded-2xl font-bold transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-background bg-gradient-to-r from-theater-purple to-theater-gold hover:from-theater-teal hover:to-theater-gold focus:ring-theater-purple text-white shadow-lg shadow-theater-purple/50 hover:scale-105 text-lg"
						>
							Create Your First Event
						</button>
					</div>
				</section>
			{:else}
				<div class="w-full flex justify-center px-4">
					<div class="flex flex-wrap justify-center gap-6 max-w-7xl">
						{#each data.hostedEvents as event, i}
							{@const status = getEventStatus(event)}
							<div class={`glass rounded-2xl sm:rounded-3xl p-5 sm:p-6 w-full min-w-[280px] flex-1 basis-[400px] max-w-2xl
								transition-all duration-500 flex flex-col gap-3
								hover:border-theater-purple/60 hover:shadow-2xl hover:shadow-theater-purple/20 hover:scale-[1.02]
								hover:-translate-y-1 group
								${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'} animate-fade-in animate-slide-up`}
							     style="transition-delay: {i * 50}ms">
								<button
									onclick={() => goto(`/night/${event.joinCode}`)}
									class="text-left w-full flex items-center gap-4 sm:gap-5"
								>
									<!-- Emoji -->
									<span class="text-5xl sm:text-6xl flex-shrink-0 group-hover:scale-110 transition-transform duration-300">🎭</span>
									
									<!-- Main content -->
									<div class="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-3">
										<!-- Title and info -->
										<div class="flex-1 min-w-0">
											<h3 class="text-lg sm:text-xl font-extrabold break-words leading-tight mb-1 relative">
												<span class="text-white transition-opacity duration-300 group-hover:opacity-0">
													{event.name}
												</span>
												<span class="absolute inset-0 bg-gradient-to-r from-theater-purple to-theater-gold bg-clip-text text-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100">
													{event.name}
												</span>
											</h3>
											{#if event.theme}
												<p class="text-sm text-theater-purple font-bold mb-2 truncate">
													🎨 {event.theme}
												</p>
											{/if}
											<div class="flex flex-wrap gap-3 text-xs text-gray-400">
												<span class="flex items-center gap-1 text-theater-teal font-mono font-bold">
													<span>🏷️</span> {event.joinCode}
												</span>
												<span class="flex items-center gap-1">
													<span>📊</span> {event.groups?.length || 0} {event.groups?.length === 1 ? 'group' : 'groups'}
												</span>
												<span class="flex items-center gap-1">
													<span>🕐</span> {formatDistanceToNow(new Date(event.createdAt))} ago
												</span>
												{#if nextDeadline(event)}
													<span class="flex items-center gap-1">
														<span>⏰</span> {formatDistanceToNow(nextDeadline(event), { addSuffix: true })}
													</span>
												{/if}
											</div>
										</div>
										
										<!-- Status badge -->
										<div class="flex-shrink-0">
											<span class={`text-sm px-3 py-1.5 rounded-xl font-bold ${status.color} whitespace-nowrap shadow-md`}>
												{status.text}
											</span>
										</div>
									</div>
								</button>
								
								{#if status.showJoin && status.urgency === 'live'}
									<button
										onclick={() => goto(`/night/${event.joinCode}/live`)}
										class="w-full px-4 py-2.5 bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700 text-white rounded-xl font-extrabold text-sm transition-all shadow-xl shadow-red-900/50 flex items-center justify-center gap-2 hover:scale-105"
									>
										<span class="w-2 h-2 bg-white rounded-full animate-pulse"></span>
										Join Live Event
									</button>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</section>
	</div>
</div>
