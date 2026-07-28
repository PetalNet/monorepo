<script lang="ts">
	import { goto } from "$app/navigation";
	import ParticleBackground from "$lib/components/ParticleBackground.svelte";
	import { formatRelativeWithTimezone, getTimezoneAbbr } from "$lib/utils/timezone";
	import { formatDistanceToNow } from "date-fns";
	import { onMount } from "svelte";

	let { data } = $props();
	let showContent = $state(false);

	onMount(() => {
		setTimeout(() => (showContent = true), 100);
	});

	function getEventStatus(event: any) {
		if (event.status === "completed")
			return {
				text: "✅ Completed",
				color: "bg-green-900/50 text-green-200 border border-green-700/50",
				urgency: "completed",
				showJoin: true,
			};
		if (event.currentPresentationId)
			return {
				text: "🎬 Live Now",
				color:
					"bg-red-900/50 text-red-200 border border-red-600/50 shadow-[0_0_20px_rgba(220,38,38,0.3)]",
				urgency: "live",
				showJoin: true,
			};
		return {
			text: "📝 Setup",
			color: "bg-theater-elevated text-purple-200 border border-purple-700/30",
			urgency: "setup",
			showJoin: false,
		};
	}

	function getGroupStatus(group: any) {
		if (group.status === "submitted")
			return {
				text: "✅ Submitted",
				color: "bg-green-900/50 text-green-200 border border-green-700/50",
				urgency: "done",
			};
		if (group.status === "late")
			return {
				text: "⏰ Late",
				color: "bg-red-900/50 text-red-200 border border-red-700/50",
				urgency: "urgent",
			};
		return {
			text: "⏳ Pending",
			color: "bg-amber-900/50 text-amber-200 border border-amber-700/50",
			urgency: "warning",
		};
	}

	function nextDeadline(event: any) {
		const deadlines =
			event.groups?.map((g: any) => (g.deadline ? new Date(g.deadline) : null)).filter(Boolean) ??
			[];
		if (!deadlines.length) return null;
		const future = deadlines.filter((d: any) => d && d > new Date());
		const soonest = (future.length ? future : deadlines).toSorted(
			(a: any, b: any) => a.getTime() - b.getTime(),
		)[0];
		return soonest;
	}
</script>

<div class="relative min-h-screen overflow-hidden bg-theater-background">
	<ParticleBackground />

	<!-- Main content -->
	<div class="relative z-10 mx-auto w-full max-w-6xl px-2 py-6 sm:px-4 sm:py-8 md:px-8 md:py-12">
		<!-- Header & Quick Stats -->
		<div
			class={`mb-6 flex flex-col items-center gap-2 transition-all duration-700 sm:mb-10 sm:gap-3 ${showContent ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"} animate-fade-in animate-slide-up`}
		>
			<h1
				class="drop-shadow-glow mb-1 bg-gradient-to-r from-theater-purple via-theater-teal to-theater-gold
				bg-clip-text text-center text-3xl font-extrabold text-transparent sm:text-4xl md:text-5xl"
			>
				Welcome back, {data.user?.name || "Presenter"}!
			</h1>
			<p class="text-center text-base text-gray-400 sm:text-lg md:text-xl">Your command center</p>
			<div class="mt-2 flex gap-3">
				<div
					class="rounded-xl border border-theater-purple/30 bg-theater-elevated px-4 py-2 text-center shadow-md"
				>
					<div class="text-xl font-bold text-theater-purple">{data.hostedEvents.length}</div>
					<div class="text-xs text-gray-400">Events</div>
				</div>
				<div
					class="rounded-xl border border-theater-teal/30 bg-theater-elevated px-4 py-2 text-center shadow-md"
				>
					<div class="text-xl font-bold text-theater-teal">{data.groupMemberships.length}</div>
					<div class="text-xs text-gray-400">Presentations</div>
				</div>
			</div>
		</div>

		<!-- Upcoming Deadlines Section -->
		{#if (() => {
			let deadlines: any[] = [];
			data.groupMemberships.forEach((m) => {
				if (m.group.event.submissionDeadline) {
					const deadline = new Date(m.group.event.submissionDeadline);
					if (deadline > new Date()) {
						deadlines.push( { type: "presentation", name: m.group.name, emoji: m.group.emoji, eventName: m.group.event.name, deadline, status: m.group.status, link: `/night/${m.group.event.joinCode}` }, );
					}
				}
			});
			return deadlines.sort((a: any, b: any) => a.deadline.getTime() - b.deadline.getTime()).length > 0;
		})()}
			{@const upcomingDeadlines = (() => {
				let deadlines: any[] = [];
				data.groupMemberships.forEach((m) => {
					if (m.group.event.submissionDeadline) {
						const deadline = new Date(m.group.event.submissionDeadline);
						if (deadline > new Date()) {
							deadlines.push({
								type: "presentation",
								name: m.group.name,
								emoji: m.group.emoji,
								eventName: m.group.event.name,
								deadline,
								status: m.group.status,
								link: `/night/${m.group.event.joinCode}`,
							});
						}
					}
				});
				return deadlines.sort((a: any, b: any) => a.deadline.getTime() - b.deadline.getTime());
			})()}
			<section class="mb-8 sm:mb-12">
				<h2 class="mb-5 text-center text-2xl font-bold text-white sm:text-3xl">
					Upcoming Deadlines
				</h2>
				<div class="flex w-full justify-center px-4">
					<div class="flex max-w-7xl flex-wrap justify-center gap-6">
						{#each upcomingDeadlines as item, i}
							<button
								onclick={() => goto(item.link)}
								class={`glass group flex w-full min-w-[280px] max-w-2xl flex-1 basis-[400px] items-center gap-4
									rounded-2xl p-5 transition-all duration-500 hover:-translate-y-1 hover:scale-[1.02]
									hover:border-theater-gold/60 hover:shadow-2xl hover:shadow-theater-gold/20 sm:gap-5
									sm:rounded-3xl sm:p-6
									${showContent ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"} animate-fade-in animate-slide-up`}
								style="transition-delay: {i * 50}ms"
							>
								<!-- Emoji -->
								<span
									class="flex-shrink-0 text-5xl transition-transform duration-300 group-hover:scale-110 sm:text-6xl"
									>{item.emoji || "📑"}</span
								>

								<!-- Main content -->
								<div
									class="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4"
								>
									<!-- Title section -->
									<div class="min-w-0 flex-1">
										<h3
											class="relative mb-1 break-words text-lg font-extrabold leading-tight sm:text-xl"
										>
											<span
												class="text-white transition-opacity duration-300 group-hover:opacity-0"
											>
												{item.name}
											</span>
											<span
												class="absolute inset-0 bg-gradient-to-r from-theater-gold to-theater-teal bg-clip-text text-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
											>
												{item.name}
											</span>
										</h3>
										<p class="truncate text-sm text-gray-400">{item.eventName}</p>
									</div>

									<!-- Deadline -->
									<div class="flex flex-shrink-0 items-center gap-3">
										<div class="text-right">
											<p
												class="whitespace-nowrap text-base font-extrabold text-theater-gold sm:text-lg"
											>
												{formatDistanceToNow(item.deadline, { addSuffix: true })}
											</p>
											<p class="text-xs text-gray-400">⏱️ Deadline</p>
										</div>
										{#if item.status === "submitted"}
											<span
												class="rounded-xl border-2 border-green-600/50 bg-green-900/60 px-3 py-1.5 text-sm font-bold text-green-200 shadow-md"
												>✅</span
											>
										{:else}
											<span
												class="animate-pulse rounded-xl border-2 border-amber-600/50 bg-amber-900/60 px-3 py-1.5 text-sm font-bold text-amber-200 shadow-md"
												>⏳</span
											>
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
			<h2 class="mb-5 text-center text-2xl font-bold text-white sm:text-3xl">Your Presentations</h2>
			{#if data.groupMemberships.length === 0}
				<section class="flex w-full items-center justify-center py-20 sm:py-28">
					<div
						class="mx-auto max-w-md animate-fade-in animate-slide-up rounded-2xl border border-gray-800/50 bg-theater-elevated p-10 text-center shadow-xl sm:p-16"
					>
						<div class="mb-6 text-6xl sm:text-7xl">📭</div>
						<p class="text-lg text-gray-400 sm:text-xl">
							You're not part of any presentations yet.
						</p>
					</div>
				</section>
			{:else}
				<div class="flex w-full justify-center px-4">
					<div class="flex max-w-7xl flex-wrap justify-center gap-6">
						{#each data.groupMemberships as membership, i}
							{@const eventStatus = getEventStatus(membership.group.event)}
							{@const groupStatus = getGroupStatus(membership.group)}
							<div
								class={`glass group flex w-full min-w-[280px] max-w-2xl flex-1 basis-[400px] flex-col gap-3
								rounded-2xl p-5 transition-all duration-500 hover:-translate-y-1
								hover:scale-[1.02] hover:border-theater-teal/60 hover:shadow-2xl hover:shadow-theater-teal/20
								sm:rounded-3xl sm:p-6
								${showContent ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"} animate-fade-in animate-slide-up`}
								style="transition-delay: {i * 50}ms"
							>
								<button
									onclick={() => goto(`/night/${membership.group.event.joinCode}`)}
									class="flex w-full items-center gap-4 text-left sm:gap-5"
								>
									<!-- Emoji -->
									<span
										class="flex-shrink-0 text-5xl transition-transform duration-300 group-hover:scale-110 sm:text-6xl"
										>{membership.group.emoji || "📑"}</span
									>

									<!-- Main content -->
									<div class="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
										<!-- Title and event -->
										<div class="min-w-0 flex-1">
											<h3
												class="relative mb-1 break-words text-lg font-extrabold leading-tight sm:text-xl"
											>
												<span
													class="text-white transition-opacity duration-300 group-hover:opacity-0"
												>
													{membership.group.name}
												</span>
												<span
													class="absolute inset-0 bg-gradient-to-r from-theater-teal to-theater-purple bg-clip-text text-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
												>
													{membership.group.name}
												</span>
											</h3>
											<p class="mb-2 truncate text-sm text-gray-400">
												{membership.group.event.name}
											</p>
											<div class="flex flex-wrap gap-2 text-xs text-gray-400">
												<span class="flex items-center gap-1">
													<span>👥</span>
													{membership.group.members?.length || 0}
												</span>
												{#if membership.isLeader}
													<span class="flex items-center gap-1 font-bold text-theater-gold">
														<span>⭐</span> Leader
													</span>
												{/if}
												{#if membership.group.event.submissionDeadline}
													<span class="flex items-center gap-1">
														<span>⏰</span>
														{formatRelativeWithTimezone(
															membership.group.event.submissionDeadline,
															membership.group.event.timezone,
														)}
													</span>
												{/if}
											</div>
										</div>

										<!-- Status badges -->
										<div class="flex flex-shrink-0 flex-wrap gap-2">
											<span
												class={`rounded-xl px-3 py-1.5 text-sm font-bold ${groupStatus.color} whitespace-nowrap shadow-md`}
											>
												{groupStatus.text}
											</span>
											{#if eventStatus.showJoin}
												<span
													class={`rounded-xl px-3 py-1.5 text-sm font-bold ${eventStatus.color} whitespace-nowrap shadow-md`}
												>
													{eventStatus.text}
												</span>
											{/if}
										</div>
									</div>
								</button>

								{#if eventStatus.showJoin && eventStatus.urgency === "live"}
									<button
										onclick={() => goto(`/night/${membership.group.event.joinCode}/live`)}
										class="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-pink-600 px-4 py-2.5 text-sm font-extrabold text-white shadow-xl shadow-red-900/50 transition-all hover:scale-105 hover:from-red-700 hover:to-pink-700"
									>
										<span class="h-2 w-2 animate-pulse rounded-full bg-white"></span>
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
			<div class="mb-5 flex flex-col justify-center gap-4 text-center sm:flex-row sm:items-center">
				<h2 class="text-center text-2xl font-bold text-white sm:text-3xl">Your Events</h2>
				{#if data.hostedEvents.length > 0}
					<button
						onclick={() => goto("/event/create")}
						class="self-center rounded-xl bg-gradient-to-r from-theater-purple to-theater-gold px-6 py-3 text-base font-bold text-white shadow-lg shadow-theater-purple/50 transition-all hover:scale-105 hover:from-theater-teal hover:to-theater-gold"
					>
						+ Create Event
					</button>
				{/if}
			</div>
			{#if data.hostedEvents.length === 0}
				<section class="flex w-full items-center justify-center py-20 sm:py-28">
					<div
						class="mx-auto max-w-md animate-fade-in animate-slide-up rounded-2xl border border-gray-800/50 bg-theater-elevated p-10 text-center shadow-xl sm:p-16"
					>
						<div class="mb-7 text-6xl sm:text-7xl">🎭</div>
						<p class="mb-7 text-lg text-gray-400 sm:text-xl">You haven't created any events yet.</p>
						<button
							onclick={() => goto("/event/create")}
							class="rounded-2xl bg-gradient-to-r from-theater-purple to-theater-gold px-8 py-4 text-lg font-bold text-white shadow-lg shadow-theater-purple/50 transition-all duration-300 hover:scale-105 hover:from-theater-teal hover:to-theater-gold focus:outline-none focus:ring-2 focus:ring-theater-purple focus:ring-offset-2 focus:ring-offset-theater-background"
						>
							Create Your First Event
						</button>
					</div>
				</section>
			{:else}
				<div class="flex w-full justify-center px-4">
					<div class="flex max-w-7xl flex-wrap justify-center gap-6">
						{#each data.hostedEvents as event, i}
							{@const status = getEventStatus(event)}
							<div
								class={`glass group flex w-full min-w-[280px] max-w-2xl flex-1 basis-[400px] flex-col gap-3
								rounded-2xl p-5 transition-all duration-500 hover:-translate-y-1
								hover:scale-[1.02] hover:border-theater-purple/60 hover:shadow-2xl hover:shadow-theater-purple/20
								sm:rounded-3xl sm:p-6
								${showContent ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"} animate-fade-in animate-slide-up`}
								style="transition-delay: {i * 50}ms"
							>
								<button
									onclick={() => goto(`/night/${event.joinCode}`)}
									class="flex w-full items-center gap-4 text-left sm:gap-5"
								>
									<!-- Emoji -->
									<span
										class="flex-shrink-0 text-5xl transition-transform duration-300 group-hover:scale-110 sm:text-6xl"
										>🎭</span
									>

									<!-- Main content -->
									<div class="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
										<!-- Title and info -->
										<div class="min-w-0 flex-1">
											<h3
												class="relative mb-1 break-words text-lg font-extrabold leading-tight sm:text-xl"
											>
												<span
													class="text-white transition-opacity duration-300 group-hover:opacity-0"
												>
													{event.name}
												</span>
												<span
													class="absolute inset-0 bg-gradient-to-r from-theater-purple to-theater-gold bg-clip-text text-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
												>
													{event.name}
												</span>
											</h3>
											{#if event.theme}
												<p class="mb-2 truncate text-sm font-bold text-theater-purple">
													🎨 {event.theme}
												</p>
											{/if}
											<div class="flex flex-wrap gap-3 text-xs text-gray-400">
												<span class="flex items-center gap-1 font-mono font-bold text-theater-teal">
													<span>🏷️</span>
													{event.joinCode}
												</span>
												<span class="flex items-center gap-1">
													<span>📊</span>
													{event.groups?.length || 0}
													{event.groups?.length === 1 ? "group" : "groups"}
												</span>
												<span class="flex items-center gap-1">
													<span>🕐</span>
													{formatDistanceToNow(new Date(event.createdAt))} ago
												</span>
												{#if nextDeadline(event)}
													<span class="flex items-center gap-1">
														<span>⏰</span>
														{formatDistanceToNow(nextDeadline(event), { addSuffix: true })}
													</span>
												{/if}
											</div>
										</div>

										<!-- Status badge -->
										<div class="flex-shrink-0">
											<span
												class={`rounded-xl px-3 py-1.5 text-sm font-bold ${status.color} whitespace-nowrap shadow-md`}
											>
												{status.text}
											</span>
										</div>
									</div>
								</button>

								{#if status.showJoin && status.urgency === "live"}
									<button
										onclick={() => goto(`/night/${event.joinCode}/live`)}
										class="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-pink-600 px-4 py-2.5 text-sm font-extrabold text-white shadow-xl shadow-red-900/50 transition-all hover:scale-105 hover:from-red-700 hover:to-pink-700"
									>
										<span class="h-2 w-2 animate-pulse rounded-full bg-white"></span>
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
