<script lang="ts">
	import type { PageData } from "./$types";

	const { data }: { data: PageData } = $props();
	const events = $derived(data.events);

	function formatDate(dateString: string, timezone?: string) {
		const date = new Date(dateString);

		return new Intl.DateTimeFormat("en-US", {
			weekday: "short",
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZone: timezone || "UTC",
		}).format(date);
	}

	function isPast(dateString: string) {
		return new Date(dateString) < new Date();
	}
</script>

<div class="mx-auto max-w-[1100px]">
	<header class="mb-8 flex flex-wrap items-center justify-between gap-4">
		<div>
			<h1
				class="text-dark-900 m-0 mb-2 flex items-center gap-2 text-[clamp(1.8rem,4vw,2.5rem)] font-bold"
			>
				<span class="text-4xl">🗓️</span>
				Your Events
			</h1>
			<p class="text-dark-700/70 m-0 text-base">Manage your events and track signups</p>
		</div>
		<a
			href="/create"
			class="bg-primary-gradient rounded-full px-6 py-3 font-semibold text-white no-underline shadow-[0_10px_20px_rgba(95,61,170,0.25)] transition-all hover:-translate-y-0.5 hover:shadow-2xl"
			>+ Create New Event</a
		>
	</header>

	{#if events.length === 0}
		<div
			class="border-primary-700/10 to-primary-50 mx-auto max-w-[500px] rounded-[24px] border bg-linear-to-br from-white px-8 py-16 text-center shadow-xl"
		>
			<div class="mb-4 text-6xl">📋</div>
			<h2 class="text-dark-800 mb-2 font-bold">No events yet</h2>
			<p class="text-dark-900/70 mb-8 leading-relaxed">
				Create your first event to start collecting signups from guests.
			</p>
			<a
				href="/create"
				class="bg-primary-gradient shadow-button inline-block rounded-full px-8 py-4 font-semibold text-white no-underline transition-all hover:-translate-y-0.5 hover:shadow-2xl"
				>Create Your First Event</a
			>
		</div>
	{:else}
		<div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-6">
			{#each events as event}
				<article
					class="border-primary-700/5 flex flex-col gap-4 rounded-2xl border bg-white p-6 shadow-[0_4px_12px_rgba(60,35,110,0.08)] transition-all hover:-translate-y-1 hover:shadow-[0_12px_24px_rgba(60,35,110,0.15)]"
					class:opacity-70={isPast(event.date)}
				>
					<div class="flex items-start justify-between gap-2">
						<h2 class="text-dark-900 m-0 flex-1 text-xl font-bold">{event.title}</h2>
						{#if isPast(event.date)}
							<span
								class="rounded-full bg-gray-500/15 px-3 py-1 text-xs font-semibold whitespace-nowrap text-gray-600"
								>Past</span
							>
						{:else}
							<span
								class="rounded-full bg-green-500/15 px-3 py-1 text-xs font-semibold whitespace-nowrap text-green-700"
								>Upcoming</span
							>
						{/if}
					</div>

					<div class="flex flex-col gap-2 text-sm">
						<div class="text-dark-900/80 flex items-center gap-2">
							<span class="text-base">📅</span>
							<span>{formatDate(event.date, event.timezone)}</span>
						</div>
						{#if event.location}
							<div class="text-dark-900/80 flex items-center gap-2">
								<span class="text-base">📍</span>
								<span>{event.location}</span>
							</div>
						{/if}
					</div>

					{#if event.description}
						<p class="text-dark-900/70 m-0 line-clamp-2 text-sm">{event.description}</p>
					{/if}

					<div
						class="border-primary-700/10 from-primary-700/5 to-accent-500/10 flex gap-8 rounded-xl border bg-linear-to-br p-4"
					>
						<div class="flex flex-col items-center">
							<div class="flex items-center gap-1">
								<span class="text-lg">✅</span>
								<span class="text-primary-700 text-2xl font-bold">{event.rsvpCount}</span>
							</div>
							<span class="text-dark-900/60 text-xs font-semibold tracking-wider uppercase"
								>RSVPs</span
							>
						</div>
						<div class="flex flex-col items-center">
							<div class="flex items-center gap-1">
								<span class="text-lg">❓</span>
								<span class="text-primary-700 text-2xl font-bold">{event.questionCount}</span>
							</div>
							<span class="text-dark-900/60 text-xs font-semibold tracking-wider uppercase"
								>Questions</span
							>
						</div>
					</div>

					<div class="mt-auto flex gap-3">
						<a
							href="/event/{event.publicCode}"
							class="bg-primary-700/10 text-primary-700 hover:bg-primary-700/20 flex-1 rounded-xl px-3 py-2.5 text-center text-sm font-semibold no-underline transition-all hover:-translate-y-0.5 hover:shadow-lg"
							>👁️ View Public</a
						>
						<a
							href="/event/manage/{event.manageToken}"
							class="bg-primary-gradient flex-1 rounded-xl px-3 py-2.5 text-center text-sm font-semibold text-white no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_16px_rgba(124,93,250,0.4)]"
							>⚙️ Manage</a
						>
					</div>
				</article>
			{/each}
		</div>
	{/if}
</div>
