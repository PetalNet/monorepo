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
				class="m-0 mb-2 flex items-center gap-2 text-[clamp(1.8rem,4vw,2.5rem)] font-bold text-dark-900"
			>
				<span class="text-4xl">🗓️</span>
				Your Events
			</h1>
			<p class="m-0 text-base text-dark-700/70">Manage your events and track signups</p>
		</div>
		<a
			href="/create"
			class="rounded-full bg-primary-gradient px-6 py-3 font-semibold text-white no-underline shadow-[0_10px_20px_rgba(95,61,170,0.25)] transition-all hover:-translate-y-0.5 hover:shadow-2xl"
			>+ Create New Event</a
		>
	</header>

	{#if events.length === 0}
		<div
			class="mx-auto max-w-[500px] rounded-[24px] border border-primary-700/10 bg-gradient-to-br from-white to-primary-50 px-8 py-16 text-center shadow-xl"
		>
			<div class="mb-4 text-6xl">📋</div>
			<h2 class="mb-2 font-bold text-dark-800">No events yet</h2>
			<p class="mb-8 leading-relaxed text-dark-900/70">
				Create your first event to start collecting signups from guests.
			</p>
			<a
				href="/create"
				class="inline-block rounded-full bg-primary-gradient px-8 py-4 font-semibold text-white no-underline shadow-button transition-all hover:-translate-y-0.5 hover:shadow-2xl"
				>Create Your First Event</a
			>
		</div>
	{:else}
		<div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-6">
			{#each events as event}
				<article
					class="flex flex-col gap-4 rounded-2xl border border-primary-700/5 bg-white p-6 shadow-[0_4px_12px_rgba(60,35,110,0.08)] transition-all hover:-translate-y-1 hover:shadow-[0_12px_24px_rgba(60,35,110,0.15)]"
					class:opacity-70={isPast(event.date)}
				>
					<div class="flex items-start justify-between gap-2">
						<h2 class="m-0 flex-1 text-xl font-bold text-dark-900">{event.title}</h2>
						{#if isPast(event.date)}
							<span
								class="whitespace-nowrap rounded-full bg-gray-500/15 px-3 py-1 text-xs font-semibold text-gray-600"
								>Past</span
							>
						{:else}
							<span
								class="whitespace-nowrap rounded-full bg-green-500/15 px-3 py-1 text-xs font-semibold text-green-700"
								>Upcoming</span
							>
						{/if}
					</div>

					<div class="flex flex-col gap-2 text-sm">
						<div class="flex items-center gap-2 text-dark-900/80">
							<span class="text-base">📅</span>
							<span>{formatDate(event.date, event.timezone)}</span>
						</div>
						{#if event.location}
							<div class="flex items-center gap-2 text-dark-900/80">
								<span class="text-base">📍</span>
								<span>{event.location}</span>
							</div>
						{/if}
					</div>

					{#if event.description}
						<p class="m-0 line-clamp-2 text-sm text-dark-900/70">{event.description}</p>
					{/if}

					<div
						class="flex gap-8 rounded-xl border border-primary-700/10 bg-gradient-to-br from-primary-700/5 to-accent-500/10 p-4"
					>
						<div class="flex flex-col items-center">
							<div class="flex items-center gap-1">
								<span class="text-lg">✅</span>
								<span class="text-2xl font-bold text-primary-700">{event.rsvpCount}</span>
							</div>
							<span class="text-xs font-semibold uppercase tracking-wider text-dark-900/60"
								>RSVPs</span
							>
						</div>
						<div class="flex flex-col items-center">
							<div class="flex items-center gap-1">
								<span class="text-lg">❓</span>
								<span class="text-2xl font-bold text-primary-700">{event.questionCount}</span>
							</div>
							<span class="text-xs font-semibold uppercase tracking-wider text-dark-900/60"
								>Questions</span
							>
						</div>
					</div>

					<div class="mt-auto flex gap-3">
						<a
							href="/event/{event.publicCode}"
							class="flex-1 rounded-xl bg-primary-700/10 px-3 py-2.5 text-center text-sm font-semibold text-primary-700 no-underline transition-all hover:-translate-y-0.5 hover:bg-primary-700/20 hover:shadow-lg"
							>👁️ View Public</a
						>
						<a
							href="/event/manage/{event.manageToken}"
							class="flex-1 rounded-xl bg-primary-gradient px-3 py-2.5 text-center text-sm font-semibold text-white no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_16px_rgba(124,93,250,0.4)]"
							>⚙️ Manage</a
						>
					</div>
				</article>
			{/each}
		</div>
	{/if}
</div>
