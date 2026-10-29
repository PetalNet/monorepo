<script lang="ts">
  import type { PageData } from './$types';

  const { data } = $props<{ data: PageData }>();
  const events = $derived(data.events);

  function formatDate(dateString: string, timezone?: string) {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone || 'UTC'
    }).format(date);
  }

  function isPast(dateString: string) {
    return new Date(dateString) < new Date();
  }
</script>

<div class="max-w-[1100px] mx-auto">
  <header class="flex justify-between items-center mb-8 flex-wrap gap-4">
    <div>
      <h1 class="m-0 text-[clamp(1.8rem,4vw,2.5rem)] text-dark-900 font-bold mb-2 flex items-center gap-2">
        <span class="text-4xl">🗓️</span>
        Your Events
      </h1>
      <p class="text-dark-700/70 text-base m-0">Manage your events and track signups</p>
    </div>
    <a href="/create" class="px-6 py-3 rounded-full bg-primary-gradient text-white no-underline font-semibold shadow-[0_10px_20px_rgba(95,61,170,0.25)] transition-all hover:-translate-y-0.5 hover:shadow-2xl">+ Create New Event</a>
  </header>

  {#if events.length === 0}
    <div class="text-center py-16 px-8 bg-gradient-to-br from-white to-primary-50 rounded-[24px] shadow-xl max-w-[500px] mx-auto border border-primary-700/10">
      <div class="text-6xl mb-4">📋</div>
      <h2 class="text-dark-800 mb-2 font-bold">No events yet</h2>
      <p class="text-dark-900/70 mb-8 leading-relaxed">Create your first event to start collecting signups from guests.</p>
      <a href="/create" class="inline-block px-8 py-4 rounded-full bg-primary-gradient text-white no-underline font-semibold shadow-button hover:-translate-y-0.5 transition-all hover:shadow-2xl">Create Your First Event</a>
    </div>
  {:else}
    <div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-6">
      {#each events as event}
        <article class="bg-white rounded-2xl p-6 shadow-[0_4px_12px_rgba(60,35,110,0.08)] transition-all flex flex-col gap-4 border border-primary-700/5 hover:-translate-y-1 hover:shadow-[0_12px_24px_rgba(60,35,110,0.15)]" class:opacity-70={isPast(event.date)}>
          <div class="flex justify-between items-start gap-2">
            <h2 class="m-0 text-xl text-dark-900 flex-1 font-bold">{event.title}</h2>
            {#if isPast(event.date)}
              <span class="px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap bg-gray-500/15 text-gray-600">Past</span>
            {:else}
              <span class="px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap bg-green-500/15 text-green-700">Upcoming</span>
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
            <p class="text-dark-900/70 text-sm m-0 line-clamp-2">{event.description}</p>
          {/if}

          <div class="flex gap-8 p-4 bg-gradient-to-br from-primary-700/5 to-accent-500/10 rounded-xl border border-primary-700/10">
            <div class="flex flex-col items-center">
              <div class="flex items-center gap-1">
                <span class="text-lg">✅</span>
                <span class="text-2xl font-bold text-primary-700">{event.rsvpCount}</span>
              </div>
              <span class="text-xs text-dark-900/60 uppercase tracking-wider font-semibold">RSVPs</span>
            </div>
            <div class="flex flex-col items-center">
              <div class="flex items-center gap-1">
                <span class="text-lg">❓</span>
                <span class="text-2xl font-bold text-primary-700">{event.questionCount}</span>
              </div>
              <span class="text-xs text-dark-900/60 uppercase tracking-wider font-semibold">Questions</span>
            </div>
          </div>

          <div class="flex gap-3 mt-auto">
            <a href="/event/{event.publicCode}" class="flex-1 px-3 py-2.5 rounded-xl no-underline font-semibold text-center text-sm transition-all bg-primary-700/10 text-primary-700 hover:bg-primary-700/20 hover:-translate-y-0.5 hover:shadow-lg">👁️ View Public</a>
            <a href="/event/manage/{event.manageToken}" class="flex-1 px-3 py-2.5 rounded-xl no-underline font-semibold text-center text-sm transition-all bg-primary-gradient text-white hover:-translate-y-0.5 hover:shadow-[0_8px_16px_rgba(124,93,250,0.4)]">⚙️ Manage</a>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>
