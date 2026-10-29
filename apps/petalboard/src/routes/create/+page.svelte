<script lang="ts">
  import type { ActionData } from './$types';
  import AddressInput from '$lib/components/AddressInput.svelte';
  import { COMMON_TIMEZONES, getUserTimezone } from '$lib/utils/timezones';

  const { form } = $props<{ form: ActionData | null }>();
  const errors = $derived<Record<string, string[]>>((form?.errors ?? {}) as Record<string, string[]>);
  const values = $derived<Record<string, string>>((form?.values ?? {}) as Record<string, string>);
  const message = $derived<string | null>(form?.message ?? null);

  let locationValue = $state('');
  let showCustomization = $state(false);
  
  // Get user's current timezone as default
  const defaultTimezone = getUserTimezone();
  
  // Emoji list - common event emojis
  const emojiList = ['🎉', '🎂', '🎊', '🎈', '🎁', '🥳', '🍰', '🎪', '🎭', '🎨', '🎵', '🎸', '🎤', '🏆', '⚽', '🏀', '🎓', '💒', '👶', '🎄', '🎃', '❤️', '🌟', '✨', '🔥', '💐', '🌸', '🌺', '🌻', '🌹'];
  
  // Update location value when form values change
  $effect(() => {
    if (values.location) {
      locationValue = values.location;
    }
  });
</script>

<h1 class="mb-2">Create an event</h1>
<p class="text-dark-900/75 max-w-[60ch] mb-8">
  Set up your event, then share the public link with your guests. You can always
  come back to update slots or details from the manage link.
</p>

{#if message}
  <p class="bg-red-500/12 rounded-2xl px-4 py-3 text-red-900 max-w-[620px] mb-6">{message}</p>
{/if}

<form method="POST" class="grid gap-6 bg-white p-6 lg:p-10 rounded-[20px] shadow-card w-full max-w-[620px]">
  <label class="form-label text-dark-800">
    <span>Event title</span>
    <input name="title" required value={values.title ?? ''} class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18" />
    {#if errors.title}
      <small class="text-red-600">{errors.title[0]}</small>
    {/if}
  </label>

  <label class="form-label text-dark-800">
    <span>Date &amp; time</span>
    <input type="datetime-local" name="date" required value={values.date ?? ''} class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18" />
    {#if errors.date}
      <small class="text-red-600">{errors.date[0]}</small>
    {/if}
  </label>

  <label class="form-label text-dark-800">
    <span>End time (optional)</span>
    <input type="datetime-local" name="endDate" value={values.endDate ?? ''} class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18" />
    {#if errors.endDate}
      <small class="text-red-600">{errors.endDate[0]}</small>
    {/if}
  </label>

  <label class="form-label text-dark-800">
    <span>Timezone</span>
    <select name="timezone" required value={values.timezone ?? defaultTimezone} class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18">
      {#each COMMON_TIMEZONES as tz}
        <option value={tz.value}>{tz.label}</option>
      {/each}
    </select>
    <small class="text-sm text-gray-600">The timezone for your event. Guests will see times in this timezone.</small>
    {#if errors.timezone}
      <small class="text-red-600">{errors.timezone[0]}</small>
    {/if}
  </label>

  <label class="form-label text-dark-800">
    <span>RSVP Limit (optional)</span>
    <input type="number" name="rsvpLimit" min="1" placeholder="No limit" value={values.rsvpLimit ?? ''} class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18" />
    {#if errors.rsvpLimit}
      <small class="text-red-600">{errors.rsvpLimit[0]}</small>
    {/if}
  </label>

  <label class="form-label text-dark-800">
    <span>Location</span>
    <AddressInput bind:value={locationValue} error={errors.location?.[0]} />
  </label>

  <label class="form-label text-dark-800">
    <span>Description</span>
    <textarea name="description" rows="4" class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 resize-y focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18" style="white-space: pre-wrap;">{values.description ?? ''}</textarea>
    <small class="text-sm text-gray-600">Supports Markdown formatting (bold, italic, lists, links, etc.)</small>
    {#if errors.description}
      <small class="text-red-600">{errors.description[0]}</small>
    {/if}
  </label>

  <!-- Customization Section -->
  <div class="border-t border-gray-200 pt-4">
    <button 
      type="button"
      onclick={() => showCustomization = !showCustomization}
      class="flex items-center gap-2 font-semibold text-dark-800 mb-4 hover:text-primary-700 transition-colors"
    >
      <span>{showCustomization ? '▼' : '▶'}</span>
      <span>Customize appearance</span>
    </button>

    {#if showCustomization}
      <div class="grid gap-6 pl-6">
        <label class="form-label text-dark-800">
          <span>Event emoji (appears in title)</span>
          <div class="flex flex-wrap gap-2 mb-2">
            {#each emojiList as emoji}
              <button
                type="button"
                onclick={() => {
                  const input = document.querySelector('input[name="emoji"]') as HTMLInputElement;
                  if (input) input.value = emoji;
                }}
                class="w-10 h-10 text-2xl hover:bg-primary-100 rounded-lg transition-colors flex items-center justify-center"
              >
                {emoji}
              </button>
            {/each}
          </div>
          <input name="emoji" placeholder="Or type any emoji (e.g., 🎉)" maxlength="10" value={values.emoji ?? ''} class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18 text-2xl" />
          {#if errors.emoji}
            <small class="text-red-600">{errors.emoji[0]}</small>
          {/if}
        </label>

        <label class="form-label text-dark-800">
          <span>Primary color</span>
          <select name="primaryColor" class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18">
            <option value="violet" selected={!values.primaryColor || values.primaryColor === 'violet'}>Violet (Default)</option>
            <option value="red" selected={values.primaryColor === 'red'}>Red</option>
            <option value="orange" selected={values.primaryColor === 'orange'}>Orange</option>
            <option value="amber" selected={values.primaryColor === 'amber'}>Amber</option>
            <option value="yellow" selected={values.primaryColor === 'yellow'}>Yellow</option>
            <option value="lime" selected={values.primaryColor === 'lime'}>Lime</option>
            <option value="green" selected={values.primaryColor === 'green'}>Green</option>
            <option value="emerald" selected={values.primaryColor === 'emerald'}>Emerald</option>
            <option value="teal" selected={values.primaryColor === 'teal'}>Teal</option>
            <option value="cyan" selected={values.primaryColor === 'cyan'}>Cyan</option>
            <option value="sky" selected={values.primaryColor === 'sky'}>Sky</option>
            <option value="blue" selected={values.primaryColor === 'blue'}>Blue</option>
            <option value="indigo" selected={values.primaryColor === 'indigo'}>Indigo</option>
            <option value="purple" selected={values.primaryColor === 'purple'}>Purple</option>
            <option value="fuchsia" selected={values.primaryColor === 'fuchsia'}>Fuchsia</option>
            <option value="pink" selected={values.primaryColor === 'pink'}>Pink</option>
            <option value="rose" selected={values.primaryColor === 'rose'}>Rose</option>
          </select>
          {#if errors.primaryColor}
            <small class="text-red-600">{errors.primaryColor[0]}</small>
          {/if}
        </label>

        <label class="form-label text-dark-800">
          <span>Secondary color</span>
          <select name="secondaryColor" class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18">
            <option value="pink" selected={!values.secondaryColor || values.secondaryColor === 'pink'}>Pink (Default)</option>
            <option value="red" selected={values.secondaryColor === 'red'}>Red</option>
            <option value="orange" selected={values.secondaryColor === 'orange'}>Orange</option>
            <option value="amber" selected={values.secondaryColor === 'amber'}>Amber</option>
            <option value="yellow" selected={values.secondaryColor === 'yellow'}>Yellow</option>
            <option value="lime" selected={values.secondaryColor === 'lime'}>Lime</option>
            <option value="green" selected={values.secondaryColor === 'green'}>Green</option>
            <option value="emerald" selected={values.secondaryColor === 'emerald'}>Emerald</option>
            <option value="teal" selected={values.secondaryColor === 'teal'}>Teal</option>
            <option value="cyan" selected={values.secondaryColor === 'cyan'}>Cyan</option>
            <option value="sky" selected={values.secondaryColor === 'sky'}>Sky</option>
            <option value="blue" selected={values.secondaryColor === 'blue'}>Blue</option>
            <option value="indigo" selected={values.secondaryColor === 'indigo'}>Indigo</option>
            <option value="violet" selected={values.secondaryColor === 'violet'}>Violet</option>
            <option value="purple" selected={values.secondaryColor === 'purple'}>Purple</option>
            <option value="fuchsia" selected={values.secondaryColor === 'fuchsia'}>Fuchsia</option>
            <option value="rose" selected={values.secondaryColor === 'rose'}>Rose</option>
          </select>
          {#if errors.secondaryColor}
            <small class="text-red-600">{errors.secondaryColor[0]}</small>
          {/if}
        </label>

        <label class="form-label text-dark-800">
          <span>Background image URL (optional)</span>
          <input type="url" name="backgroundImage" placeholder="https://example.com/image.jpg" value={values.backgroundImage ?? ''} class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18" />
          <small class="text-dark-700/60">Use a high-quality image for best results</small>
          {#if errors.backgroundImage}
            <small class="text-red-600">{errors.backgroundImage[0]}</small>
          {/if}
        </label>
      </div>
    {/if}
  </div>

  <button type="submit" class="justify-self-start px-7 py-3.5 rounded-full border-none bg-primary-gradient text-white font-semibold cursor-pointer shadow-button hover:-translate-y-px">Create event</button>
</form>
