<script lang="ts">
  import type { ActionData, PageData } from './$types';
  import { enhance } from '$app/forms';

  let { data, form } = $props<{ data: PageData; form: ActionData | null }>();

  const profileErrors = $derived<Record<string, string[]>>(
    (form?.type === 'updateProfile' && form.errors ? form.errors : {}) as Record<string, string[]>
  );

  const profileValues = $derived<Record<string, string>>(
    (form?.type === 'updateProfile' && form.values ? form.values : {}) as Record<string, string>
  );

  const passwordErrors = $derived<Record<string, string[]>>(
    (form?.type === 'changePassword' && form.errors ? form.errors : {}) as Record<string, string[]>
  );

  const deleteErrors = $derived<Record<string, string[]>>(
    (form?.type === 'deleteAccount' && form.errors ? form.errors : {}) as Record<string, string[]>
  );

  const successMessage = $derived<string | null>(
    (() => {
      if (!form?.success) return null;
      return form.message || null;
    })()
  );

  const errorMessage = $derived<string | null>(
    form?.message && !form?.success ? form.message : null
  );

  let showDeleteModal = $state(false);
</script>

<div class="max-w-[800px] mx-auto">
  <header class="mb-8">
    <h1 class="text-3xl font-bold text-dark-800 mb-2 flex items-center gap-2">
      <span class="text-4xl">⚙️</span>
      Settings
    </h1>
    <p class="text-dark-700/70">Manage your account settings and preferences</p>
  </header>

  {#if successMessage}
    <div class="success-banner mb-6">{successMessage}</div>
  {/if}

  {#if errorMessage}
    <div class="error-banner mb-6">{errorMessage}</div>
  {/if}

  <!-- Profile Settings -->
  <section class="card mb-6">
    <h2 class="text-2xl font-bold text-dark-800 mb-6 flex items-center gap-2">
      <span class="text-2xl">👤</span>
      Profile Information
    </h2>
    <form
      method="POST"
      action="?/updateProfile"
      class="space-y-5"
      use:enhance={() => {
        return async ({ update }) => {
          await update({ reset: false });
        };
      }}
    >
      <label class="form-label">
        <span>Name *</span>
        <input
          class="input-field"
          type="text"
          name="name"
          value={profileValues.name ?? data.user.name}
          required
        />
        {#if profileErrors.name}
          <small class="text-red-600 text-sm">{profileErrors.name[0]}</small>
        {/if}
      </label>

      <label class="form-label">
        <span>Email *</span>
        <input
          class="input-field"
          type="email"
          name="email"
          value={profileValues.email ?? data.user.email}
          required
        />
        {#if profileErrors.email}
          <small class="text-red-600 text-sm">{profileErrors.email[0]}</small>
        {/if}
      </label>

      <button class="btn-primary" type="submit">Update Profile</button>
    </form>
  </section>

  <!-- Change Password -->
  <section class="card mb-6">
    <h2 class="text-2xl font-bold text-dark-800 mb-6 flex items-center gap-2">
      <span class="text-2xl">🔒</span>
      Change Password
    </h2>
    <form
      method="POST"
      action="?/changePassword"
      class="space-y-5"
      use:enhance={() => {
        return async ({ update, formElement }) => {
          await update({ reset: false });
          formElement.reset();
        };
      }}
    >
      <label class="form-label">
        <span>Current Password *</span>
        <input
          class="input-field"
          type="password"
          name="currentPassword"
          required
          autocomplete="current-password"
        />
        {#if passwordErrors.currentPassword}
          <small class="text-red-600 text-sm">{passwordErrors.currentPassword[0]}</small>
        {/if}
      </label>

      <label class="form-label">
        <span>New Password *</span>
        <input
          class="input-field"
          type="password"
          name="newPassword"
          required
          autocomplete="new-password"
        />
        <small class="text-sm text-gray-600">Must be at least 8 characters</small>
        {#if passwordErrors.newPassword}
          <small class="text-red-600 text-sm">{passwordErrors.newPassword[0]}</small>
        {/if}
      </label>

      <label class="form-label">
        <span>Confirm New Password *</span>
        <input
          class="input-field"
          type="password"
          name="confirmPassword"
          required
          autocomplete="new-password"
        />
        {#if passwordErrors.confirmPassword}
          <small class="text-red-600 text-sm">{passwordErrors.confirmPassword[0]}</small>
        {/if}
      </label>

      <button class="btn-primary" type="submit">Change Password</button>
    </form>
  </section>

  <!-- Account Information -->
  <section class="card mb-6">
    <h2 class="text-2xl font-bold text-dark-800 mb-6 flex items-center gap-2">
      <span class="text-2xl">📊</span>
      Account Information
    </h2>
    <div class="space-y-4">
      <div class="flex justify-between items-center py-3 border-b border-gray-200">
        <span class="text-gray-600 font-medium">Account Created</span>
        <span class="text-dark-800">{new Date(data.user.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
      </div>
      <div class="flex justify-between items-center py-3 border-b border-gray-200">
        <span class="text-gray-600 font-medium">Email Verified</span>
        <span class="text-dark-800">
          {#if data.user.emailVerified}
            <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-green-500/15 text-green-700">
              <span>✓</span> Verified
            </span>
          {:else}
            <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-yellow-500/15 text-yellow-700">
              <span>⏳</span> Pending
            </span>
          {/if}
        </span>
      </div>
      <div class="flex justify-between items-center py-3">
        <span class="text-gray-600 font-medium">User ID</span>
        <span class="text-dark-800 font-mono text-sm">{data.user.id}</span>
      </div>
    </div>
  </section>

  <!-- Spotify Integration -->
  <section class="card mb-6">
    <h2 class="text-2xl font-bold text-dark-800 mb-6 flex items-center gap-2">
      <span class="text-2xl">🎵</span>
      Spotify Integration
    </h2>
    <div class="space-y-4">
      {#if data.user.spotifyAccessToken}
        <div class="bg-gradient-to-br from-green-50 to-green-100/50 rounded-xl p-5 border border-green-200">
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-3">
              <div class="w-12 h-12 rounded-full bg-green-500 flex items-center justify-center text-white text-xl">
                ✓
              </div>
              <div>
                <h3 class="font-semibold text-dark-900">Spotify Connected</h3>
                <p class="text-sm text-green-700">You can now add playlist questions to your events</p>
              </div>
            </div>
            <form method="POST" action="?/disconnectSpotify" use:enhance={() => {
              return async ({ result, update }) => {
                await update();
              };
            }}>
              <button type="submit" class="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-white border border-green-300 text-green-700 hover:bg-green-50">
                Disconnect
              </button>
            </form>
          </div>
        </div>
      {:else}
        <div class="bg-gradient-to-br from-white to-primary-50 rounded-xl p-5 border border-primary-700/10">
          <div class="flex items-start gap-4">
            <div class="w-12 h-12 rounded-full bg-primary-100 flex items-center justify-center text-2xl">
              🎵
            </div>
            <div class="flex-1">
              <h3 class="font-semibold text-dark-900 mb-2">Connect Spotify</h3>
              <p class="text-sm text-dark-700 mb-4">
                Connect your Spotify account to create collaborative playlist questions for your events. 
                Guests can suggest songs to add to your event playlist!
              </p>
              <a
                href="/api/spotify/auth"
                data-sveltekit-preload-data="off"
                data-sveltekit-reload
                class="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold transition-all bg-[#1DB954] text-white hover:bg-[#1ed760] hover:-translate-y-0.5 hover:shadow-lg"
              >
                <span>🎵</span>
                Connect Spotify
              </a>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- Danger Zone -->
  <section class="card border-2 border-red-200 bg-red-50/50">
    <h2 class="text-2xl font-bold text-red-700 mb-4 flex items-center gap-2">
      <span class="text-2xl">⚠️</span>
      Danger Zone
    </h2>
    <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
      <div>
        <h3 class="text-lg font-semibold text-dark-800 mb-2">Delete Account</h3>
        <p class="text-sm text-gray-600">
          This will permanently delete your account, all your events, and all associated data. This action cannot be undone.
        </p>
      </div>
      <button
        type="button"
        class="btn-danger whitespace-nowrap"
        onclick={() => (showDeleteModal = true)}
      >
        Delete Account
      </button>
    </div>
  </section>
</div>

{#if showDeleteModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => (showDeleteModal = false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h2 class="flex items-center gap-2">
          <span class="text-2xl">⚠️</span>
          Confirm Account Deletion
        </h2>
        <button type="button" class="close-btn" onclick={() => (showDeleteModal = false)}>✕</button>
      </div>

      <form
        method="POST"
        action="?/deleteAccount"
        class="px-8 py-6"
        use:enhance={() => {
          return async ({ update }) => {
            await update();
          };
        }}
      >
        <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p class="text-sm text-red-800 font-semibold mb-2">⚠️ Warning: This action cannot be undone!</p>
          <p class="text-sm text-red-700">
            Deleting your account will permanently remove:
          </p>
          <ul class="list-disc list-inside text-sm text-red-700 mt-2 space-y-1">
            <li>Your profile and account information</li>
            <li>All events you've created</li>
            <li>All RSVPs and responses to your events</li>
            <li>All questions and event data</li>
          </ul>
        </div>

        <label class="form-label">
          <span>Enter your password to confirm *</span>
          <input
            class="input-field"
            type="password"
            name="password"
            required
            autocomplete="current-password"
          />
          {#if deleteErrors.password}
            <small class="text-red-600 text-sm">{deleteErrors.password[0]}</small>
          {/if}
        </label>

        <div class="flex gap-3 mt-6">
          <button type="button" class="btn-secondary flex-1" onclick={() => (showDeleteModal = false)}>
            Cancel
          </button>
          <button type="submit" class="btn-danger flex-1">Delete My Account</button>
        </div>
      </form>
    </div>
  </div>
{/if}
