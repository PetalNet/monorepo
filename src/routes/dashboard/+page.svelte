<script lang="ts">
	import { goto } from '$app/navigation';
	import { formatDistanceToNow, formatDistance } from 'date-fns';
	import { formatRelativeWithTimezone, formatInTimezone, getTimezoneAbbr } from '$lib/utils/timezone';

	let { data } = $props();

	function getEventStatus(event: any) {
		if (event.status === 'completed') return { text: '✅ Completed', color: 'bg-green-700 text-green-200', showJoin: true };
		if (event.currentPresentationId) return { text: '🎬 Presenting', color: 'bg-red-700 text-red-200 animate-pulse', showJoin: true };
		return { text: '📝 Setup', color: 'bg-theater-purple text-purple-100', showJoin: false };
	}

	function getGroupStatus(group: any) {
		if (group.status === 'submitted') return { text: '✅ Submitted', color: 'bg-green-700 text-green-200' };
		if (group.status === 'late') return { text: '⏰ Late', color: 'bg-red-700 text-red-200' };
		return { text: '⏳ Pending', color: 'bg-theater-purple text-purple-100' };
	}

	function nextDeadline(event: any) {
		const deadlines = event.groups?.map((g: any) => g.deadline ? new Date(g.deadline) : null).filter(Boolean) ?? [];
		if (!deadlines.length) return null;
		const future = deadlines.filter((d: any) => d && d > new Date());
		const soonest = (future.length ? future : deadlines).sort((a: any, b: any) => a.getTime() - b.getTime())[0];
		return soonest;
	}
</script>

<div class="min-h-screen p-3 sm:p-4 md:p-8 bg-theater-darker">
	<div class="max-w-7xl mx-auto">
		<!-- Header & Create Event Button -->
		<div class="flex flex-col gap-3 sm:gap-4 mb-6 sm:mb-8">
			<div>
				<h1 class="text-2xl sm:text-3xl md:text-4xl font-bold mb-1 text-white">Welcome, {data.user?.name || 'Presenter'}!</h1>
				<p class="text-sm sm:text-base text-gray-400">Your dashboard overview</p>
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
			<section class="mb-8 sm:mb-10">
				<h2 class="text-xl sm:text-2xl font-semibold text-white mb-3">⏰ Upcoming Deadlines</h2>
				<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
					{#each upcomingDeadlines as item}
						<button
							onclick={() => goto(item.link)}
							class="bg-theater-dark rounded-xl p-3 sm:p-4 shadow-lg border border-gray-800 text-left hover:border-yellow-500 transition-all"
						>
							<div class="flex items-start justify-between gap-2 mb-2">
								<div class="flex items-center gap-2 min-w-0 flex-1">
									<span class="text-xl sm:text-2xl flex-shrink-0">{item.emoji || '📑'}</span>
									<div class="min-w-0 flex-1">
										<h3 class="text-base sm:text-lg font-semibold text-white break-words">{item.name}</h3>
										<p class="text-xs text-gray-400 truncate">{item.eventName}</p>
									</div>
								</div>
								{#if item.status === 'submitted'}
									<span class="text-xs px-2 py-1 rounded bg-green-700 text-green-200 whitespace-nowrap flex-shrink-0">✅</span>
								{:else}
									<span class="text-xs px-2 py-1 rounded bg-yellow-700 text-yellow-200 whitespace-nowrap flex-shrink-0">⏳</span>
								{/if}
							</div>
							<p class="text-xs sm:text-sm text-yellow-400 font-semibold">
								Due {formatDistanceToNow(item.deadline, { addSuffix: true })}
							</p>
						</button>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Your Presentations Section -->
		<section class="mb-10 sm:mb-14">
			<h2 class="text-xl sm:text-2xl font-semibold text-white mb-3">Your Presentations</h2>
			{#if data.groupMemberships.length === 0}
				<div class="bg-theater-dark rounded-xl p-6 sm:p-8 md:p-12 shadow-lg border border-gray-800 text-center">
					<p class="text-sm sm:text-base text-gray-400">You're not part of any presentations yet.</p>
				</div>
			{:else}
				<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
					{#each data.groupMemberships as membership}
						{@const eventStatus = getEventStatus(membership.group.event)}
						<div class="bg-theater-dark rounded-xl sm:rounded-2xl p-4 sm:p-6 shadow-lg border border-gray-800 hover:border-theater-purple transition-all duration-200 group">
							<button
								onclick={() => goto(`/night/${membership.group.event.joinCode}`)}
								class="text-left w-full"
							>
								<div class="flex justify-between items-start gap-2 mb-2">
									<h3 class="text-base sm:text-lg font-semibold flex items-center gap-2 text-white min-w-0 flex-1 break-words">
										<span class="flex-shrink-0">{membership.group.emoji || '📑'}</span>
										<span class="break-words">{membership.group.name}</span>
									</h3>
									<span class={`text-xs px-2 py-1 rounded font-semibold ${getGroupStatus(membership.group).color} whitespace-nowrap flex-shrink-0`}>
										{getGroupStatus(membership.group).text}
									</span>
								</div>
								<p class="text-xs sm:text-sm text-gray-400 mb-1 truncate">
									Event: <span class="font-semibold text-white">{membership.group.event.name}</span>
								</p>
								{#if eventStatus.showJoin}
									<p class="text-xs sm:text-sm mb-2 flex items-center gap-1">
										<span class={`px-2 py-0.5 rounded font-semibold ${eventStatus.color}`}>
											{eventStatus.text}
										</span>
									</p>
								{/if}
								<div class="flex flex-wrap gap-x-3 sm:gap-x-4 gap-y-1 text-gray-400 text-xs sm:text-sm mb-1">
									<p class="whitespace-nowrap">👥 {membership.group.members?.length || 0}</p>
									{#if membership.isLeader}
										<p class="text-theater-purple whitespace-nowrap">⭐ Leader</p>
									{/if}
								</div>
								<div class="flex flex-wrap gap-x-3 sm:gap-x-4 gap-y-1 text-gray-500 text-xs">
									{#if membership.group.event.submissionDeadline}
										<p class="whitespace-nowrap">
											⏰ {formatRelativeWithTimezone(membership.group.event.submissionDeadline, membership.group.event.timezone)} ({getTimezoneAbbr(membership.group.event.timezone)})
										</p>
									{/if}
									<p class="whitespace-nowrap">🕐 {formatDistanceToNow(new Date(membership.joinedAt))} ago</p>
								</div>
							</button>
							{#if eventStatus.showJoin}
								<button
									onclick={() => goto(`/night/${membership.group.event.joinCode}/live`)}
									class="w-full mt-3 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-sm transition-all shadow-lg flex items-center justify-center gap-2"
								>
									<span class="w-2 h-2 bg-white rounded-full animate-pulse"></span>
									Join Live Event
								</button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- Your Events Section -->
		<section class="mb-8 sm:mb-14">
			<div class="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-3 mb-3">
				<h2 class="text-xl sm:text-2xl font-semibold text-white">Your Events</h2>
				{#if data.hostedEvents.length > 0}
					<button
						onclick={() => goto('/event/create')}
						class="px-4 py-2 rounded-lg text-sm sm:text-base bg-theater-purple text-white hover:bg-purple-600 transition self-start"
					>
						+ Create Event
					</button>
				{/if}
			</div>
			{#if data.hostedEvents.length === 0}
				<div class="bg-theater-dark rounded-xl p-6 sm:p-8 md:p-12 shadow-lg border border-gray-800 text-center">
					<p class="text-sm sm:text-base text-gray-400 mb-4">You haven't created any events yet.</p>
					<button
						onclick={() => goto('/event/create')}
						class="px-4 py-2.5 sm:px-5 sm:py-3 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-theater-purple hover:bg-purple-600 focus:ring-theater-purple text-sm sm:text-base"
					>
						Create Your First Event
					</button>
				</div>
			{:else}
				<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
					{#each data.hostedEvents as event}
						{@const status = getEventStatus(event)}
						<div class="bg-theater-dark rounded-xl sm:rounded-2xl p-4 sm:p-6 shadow-lg border border-gray-800 hover:border-theater-purple transition-all duration-200 group">
							<button
								onclick={() => goto(`/night/${event.joinCode}`)}
								class="text-left w-full"
							>
								<div class="flex justify-between items-start gap-2 mb-2">
									<h3 class="text-base sm:text-lg md:text-xl font-semibold text-white min-w-0 flex-1 break-words">
										{event.name}
									</h3>
									<span class={`text-xs px-2 py-1 rounded font-semibold ${status.color} whitespace-nowrap flex-shrink-0`}>
										{status.text}
									</span>
								</div>
								{#if event.theme}
									<p class="text-xs sm:text-sm text-theater-purple mb-1 truncate">Theme: {event.theme}</p>
								{/if}
								<div class="flex flex-wrap gap-x-3 sm:gap-x-4 gap-y-1 text-gray-400 text-xs sm:text-sm mb-1">
									<p class="whitespace-nowrap">🏷️ <span class="font-mono">{event.joinCode}</span></p>
									<p class="whitespace-nowrap">📊 {event.groups?.length || 0}</p>
								</div>
								<div class="flex flex-wrap gap-x-3 sm:gap-x-4 gap-y-1 text-gray-500 text-xs">
									<p class="whitespace-nowrap">🕐 {formatDistanceToNow(new Date(event.createdAt))} ago</p>
									{#if nextDeadline(event)}
										<p class="whitespace-nowrap">
											⏰ {formatDistanceToNow(nextDeadline(event), { addSuffix: true })}
										</p>
									{/if}
								</div>
							</button>
							{#if status.showJoin}
								<button
									onclick={() => goto(`/night/${event.joinCode}/live`)}
									class="w-full mt-3 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-sm transition-all shadow-lg flex items-center justify-center gap-2"
								>
									<span class="w-2 h-2 bg-white rounded-full animate-pulse"></span>
									Join Live Event
								</button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>


	</div>
</div>
