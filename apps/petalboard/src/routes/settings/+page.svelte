<script lang="ts">
	import { enhance } from "$app/forms";

	import type { ActionData, PageData } from "./$types";

	let { data, form }: { data: PageData; form: ActionData | null } = $props();

	const profileErrors = $derived<Record<string, string[]>>(
		(form?.type === "updateProfile" && form.errors ? form.errors : {}) as Record<string, string[]>,
	);

	const profileValues = $derived<Record<string, string>>(
		(form?.type === "updateProfile" && form.values ? form.values : {}) as Record<string, string>,
	);

	const deleteErrors = $derived<Record<string, string[]>>(
		(form?.type === "deleteAccount" && form.errors ? form.errors : {}) as Record<string, string[]>,
	);

	const successMessage = $derived<string | null>(
		(() => {
			if (!form?.success) {
				return null;
			}

			return form.message || null;
		})(),
	);

	const errorMessage = $derived<string | null>(
		form?.message && !form?.success ? form.message : null,
	);

	let showDeleteModal = $state(false);
</script>

<div class="mx-auto max-w-[800px]">
	<header class="mb-8">
		<h1 class="mb-2 flex items-center gap-2 text-3xl font-bold text-dark-800">
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
		<h2 class="mb-6 flex items-center gap-2 text-2xl font-bold text-dark-800">
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
					<small class="text-sm text-red-600">{profileErrors.name[0]}</small>
				{/if}
			</label>

			<div class="form-label">
				<span>Email</span>
				<p class="input-field mb-0">{data.user.email}</p>
				<small class="text-sm text-gray-600">Managed by PetalNet</small>
			</div>

			<button class="btn-primary" type="submit">Update Profile</button>
		</form>
	</section>

	<!-- Account Information -->
	<section class="card mb-6">
		<h2 class="mb-6 flex items-center gap-2 text-2xl font-bold text-dark-800">
			<span class="text-2xl">📊</span>
			Account Information
		</h2>
		<div class="space-y-4">
			<div class="flex items-center justify-between border-b border-gray-200 py-3">
				<span class="font-medium text-gray-600">Account Created</span>
				<span class="text-dark-800"
					>{new Date(data.user.createdAt).toLocaleDateString("en-US", {
						year: "numeric",
						month: "long",
						day: "numeric",
					})}</span
				>
			</div>
			<div class="flex items-center justify-between py-3">
				<span class="font-medium text-gray-600">User ID</span>
				<span class="font-mono text-sm text-dark-800">{data.user.id}</span>
			</div>
		</div>
	</section>

	<!-- Spotify Integration -->
	<section class="card mb-6">
		<h2 class="mb-6 flex items-center gap-2 text-2xl font-bold text-dark-800">
			<span class="text-2xl">🎵</span>
			Spotify Integration
		</h2>
		<div class="space-y-4">
			{#if data.user.spotifyAccessToken}
				<div
					class="rounded-xl border border-green-200 bg-gradient-to-br from-green-50 to-green-100/50 p-5"
				>
					<div class="flex items-start justify-between gap-4">
						<div class="flex items-center gap-3">
							<div
								class="flex h-12 w-12 items-center justify-center rounded-full bg-green-500 text-xl text-white"
							>
								✓
							</div>
							<div>
								<h3 class="font-semibold text-dark-900">Spotify Connected</h3>
								<p class="text-sm text-green-700">
									You can now add playlist questions to your events
								</p>
							</div>
						</div>
						<form
							method="POST"
							action="?/disconnectSpotify"
							use:enhance={() => {
								return async ({ result, update }) => {
									await update();
								};
							}}
						>
							<button
								type="submit"
								class="rounded-lg border border-green-300 bg-white px-4 py-2 text-sm font-medium text-green-700 transition-colors hover:bg-green-50"
							>
								Disconnect
							</button>
						</form>
					</div>
				</div>
			{:else}
				<div
					class="rounded-xl border border-primary-700/10 bg-gradient-to-br from-white to-primary-50 p-5"
				>
					<div class="flex items-start gap-4">
						<div
							class="flex h-12 w-12 items-center justify-center rounded-full bg-primary-100 text-2xl"
						>
							🎵
						</div>
						<div class="flex-1">
							<h3 class="mb-2 font-semibold text-dark-900">Connect Spotify</h3>
							<p class="mb-4 text-sm text-dark-700">
								Connect your Spotify account to create collaborative playlist questions for your
								events. Guests can suggest songs to add to your event playlist!
							</p>
							<a
								href="/api/spotify/auth"
								data-sveltekit-preload-data="off"
								data-sveltekit-reload
								class="inline-flex items-center gap-2 rounded-lg bg-[#1DB954] px-5 py-2.5 font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-[#1ed760] hover:shadow-lg"
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
		<h2 class="mb-4 flex items-center gap-2 text-2xl font-bold text-red-700">
			<span class="text-2xl">⚠️</span>
			Danger Zone
		</h2>
		<div class="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
			<div>
				<h3 class="mb-2 text-lg font-semibold text-dark-800">Delete Account</h3>
				<p class="text-sm text-gray-600">
					This will permanently delete your account, all your events, and all associated data. This
					action cannot be undone.
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
				<div class="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
					<p class="mb-2 text-sm font-semibold text-red-800">
						⚠️ Warning: This action cannot be undone!
					</p>
					<p class="text-sm text-red-700">Deleting your account will permanently remove:</p>
					<ul class="mt-2 list-inside list-disc space-y-1 text-sm text-red-700">
						<li>Your profile and account information</li>
						<li>All events you've created</li>
						<li>All RSVPs and responses to your events</li>
						<li>All questions and event data</li>
					</ul>
				</div>

				<label class="form-label">
					<span>Enter your account email to confirm *</span>
					<input class="input-field" type="email" name="email" required autocomplete="email" />
					{#if deleteErrors.email}
						<small class="text-sm text-red-600">{deleteErrors.email[0]}</small>
					{/if}
				</label>

				<div class="mt-6 flex gap-3">
					<button
						type="button"
						class="btn-secondary flex-1"
						onclick={() => (showDeleteModal = false)}
					>
						Cancel
					</button>
					<button type="submit" class="btn-danger flex-1">Delete My Account</button>
				</div>
			</form>
		</div>
	</div>
{/if}
