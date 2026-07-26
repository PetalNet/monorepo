<script lang="ts">
	import { enhance } from "$app/forms";
	import { invalidateAll } from "$app/navigation";
	import PageContainer from "$lib/components/PageContainer.svelte";
	import PageHeader from "$lib/components/PageHeader.svelte";

	let { data, form } = $props();

	let showDeleteConfirm = $state(false);
	let deleteConfirmText = $state("");

	// Edit modals
	let editingName = $state(false);
	let editingEmail = $state(false);
	let editingPassword = $state(false);

	// Form values
	let newName = $state("");
	let newEmail = $state("");
	let emailPassword = $state("");
	let currentPassword = $state("");
	let newPassword = $state("");
	let confirmPassword = $state("");

	// Success/error messages
	let nameMessage = $state("");
	let emailMessage = $state("");
	let passwordMessage = $state("");

	function openNameEdit() {
		newName = data.user.name;
		editingName = true;
		nameMessage = "";
	}

	function openEmailEdit() {
		newEmail = data.user.email;
		emailPassword = "";
		editingEmail = true;
		emailMessage = "";
	}

	function openPasswordEdit() {
		currentPassword = "";
		newPassword = "";
		confirmPassword = "";
		editingPassword = true;
		passwordMessage = "";
	}

	function closeModals() {
		editingName = false;
		editingEmail = false;
		editingPassword = false;
	}
</script>

<PageContainer>
	<PageHeader
		title="Account Settings"
		subtitle="Manage your account preferences"
		backLink="/dashboard"
	/>

	<!-- Account Information -->
	<div class="glass mb-6 rounded-xl p-6">
		<h2 class="mb-6 text-2xl font-semibold">Account Information</h2>

		<div class="space-y-6">
			<div>
				<label for="name" class="mb-2 block text-sm font-medium text-gray-300">Name</label>
				<div class="flex items-center gap-4">
					<input
						id="name"
						type="text"
						value={data.user.name}
						disabled
						class="flex-1 rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white"
					/>
					<button
						onclick={openNameEdit}
						class="rounded-lg bg-theater-purple px-4 py-2 text-white transition hover:bg-purple-700"
					>
						Edit
					</button>
				</div>
			</div>

			<div>
				<label for="email" class="mb-2 block text-sm font-medium text-gray-300">Email</label>
				<div class="flex items-center gap-4">
					<input
						id="email"
						type="email"
						value={data.user.email}
						disabled
						class="flex-1 rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white"
					/>
					<button
						onclick={openEmailEdit}
						class="rounded-lg bg-theater-purple px-4 py-2 text-white transition hover:bg-purple-700"
					>
						Edit
					</button>
				</div>
			</div>

			<div>
				<label for="password" class="mb-2 block text-sm font-medium text-gray-300">Password</label>
				<div class="flex items-center gap-4">
					<input
						id="password"
						type="password"
						value="••••••••••••"
						disabled
						class="flex-1 rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white"
					/>
					<button
						onclick={openPasswordEdit}
						class="rounded-lg bg-theater-purple px-4 py-2 text-white transition hover:bg-purple-700"
					>
						Change
					</button>
				</div>
			</div>
		</div>
	</div>

	<!-- Preferences -->
	<div class="glass mb-6 rounded-xl p-6">
		<h2 class="mb-6 text-2xl font-semibold">Preferences</h2>

		<div class="space-y-4">
			<div class="flex items-center justify-between py-3">
				<div>
					<h3 class="font-medium text-white">Dark Mode</h3>
					<p class="text-sm text-gray-400">Always enabled for the best theater experience</p>
				</div>
				<div class="relative inline-flex h-6 w-11 items-center rounded-full bg-theater-purple">
					<span class="inline-block h-4 w-4 translate-x-6 transform rounded-full bg-white"></span>
				</div>
			</div>
		</div>
	</div>

	<!-- Danger Zone -->
	<div class="rounded-xl border border-red-900/50 bg-red-950/20 p-6 shadow-lg">
		<h2 class="mb-4 text-2xl font-semibold text-red-400">Danger Zone</h2>

		<div class="space-y-4">
			<div class="py-4">
				<div class="mb-4 flex items-start justify-between">
					<div class="flex-1">
						<h3 class="mb-2 font-medium text-white">Delete Account</h3>
						<p class="mb-2 text-sm text-gray-400">
							Permanently delete your account and all associated data. This action cannot be undone.
						</p>
						<p class="text-sm text-red-400">⚠️ This will delete:</p>
						<ul class="ml-2 mt-1 list-inside list-disc text-sm text-gray-400">
							<li>All events you've hosted</li>
							<li>All presentation registrations</li>
							<li>All votes and submissions</li>
							<li>Your account information</li>
						</ul>
					</div>
					<button
						onclick={() => (showDeleteConfirm = true)}
						class="rounded-lg bg-red-900/50 px-4 py-2 text-red-300 transition hover:bg-red-900"
					>
						Delete Account
					</button>
				</div>
			</div>
		</div>
	</div>
</PageContainer>

<!-- Delete Account Confirmation Modal -->
{#if showDeleteConfirm}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
		<div class="glass-strong w-full max-w-md rounded-xl border-red-900/50 p-8 shadow-2xl">
			<h3 class="mb-4 text-2xl font-bold text-red-400">⚠️ Delete Account</h3>

			<p class="mb-4 text-white">
				This will permanently delete your account and all associated data. This action cannot be
				undone.
			</p>

			<div class="mb-6 rounded-lg border border-red-900/50 bg-red-950/30 p-4">
				<p class="mb-3 text-sm text-red-300">To confirm, type <strong>DELETE</strong> below:</p>
				<input
					type="text"
					bind:value={deleteConfirmText}
					placeholder="Type DELETE"
					class="w-full rounded-lg border border-red-700 bg-theater-darker px-4 py-2 text-white focus:border-red-500 focus:outline-none"
				/>
			</div>

			<form method="POST" action="?/deleteAccount" use:enhance class="space-y-3">
				<button
					type="submit"
					disabled={deleteConfirmText !== "DELETE"}
					class="w-full rounded-lg bg-red-600 py-3 font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-700"
				>
					Permanently Delete Account
				</button>
				<button
					type="button"
					onclick={() => {
						showDeleteConfirm = false;
						deleteConfirmText = "";
					}}
					class="w-full rounded-lg bg-gray-700 py-3 font-semibold text-white transition hover:bg-gray-600"
				>
					Cancel
				</button>
			</form>
		</div>
	</div>
{/if}

<!-- Edit Name Modal -->
{#if editingName}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
		onclick={(e) => e.target === e.currentTarget && closeModals()}
		role="button"
		tabindex="0"
		onkeydown={(e) => e.key === "Escape" && closeModals()}
	>
		<div class="glass-strong w-full max-w-md rounded-xl p-8 shadow-2xl">
			<h3 class="mb-4 text-2xl font-bold text-white">Edit Name</h3>

			{#if form?.error && form?.error.includes("name")}
				<div class="mb-4 rounded-lg border border-red-700 bg-red-900/30 p-3 text-sm text-red-300">
					{form.error}
				</div>
			{/if}

			{#if form?.success && form?.message?.includes("Name")}
				<div
					class="mb-4 rounded-lg border border-green-700 bg-green-900/30 p-3 text-sm text-green-300"
				>
					{form.message}
				</div>
			{/if}

			<form
				method="POST"
				action="?/updateName"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === "success") {
							await invalidateAll();
							setTimeout(() => closeModals(), 1500);
						}
					};
				}}
			>
				<div class="mb-6">
					<label for="newName" class="mb-2 block text-sm font-medium text-gray-300">New Name</label>
					<input
						id="newName"
						name="name"
						type="text"
						bind:value={newName}
						required
						class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white focus:border-theater-purple focus:outline-none"
						placeholder="Your name"
					/>
				</div>

				<div class="flex gap-3">
					<button
						type="submit"
						class="flex-1 rounded-lg bg-theater-purple py-3 font-semibold text-white transition hover:bg-purple-700"
					>
						Save Changes
					</button>
					<button
						type="button"
						onclick={closeModals}
						class="flex-1 rounded-lg bg-gray-700 py-3 font-semibold text-white transition hover:bg-gray-600"
					>
						Cancel
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Edit Email Modal -->
{#if editingEmail}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
		onclick={(e) => e.target === e.currentTarget && closeModals()}
		role="button"
		tabindex="0"
		onkeydown={(e) => e.key === "Escape" && closeModals()}
	>
		<div class="glass-strong w-full max-w-md rounded-xl p-8 shadow-2xl">
			<h3 class="mb-4 text-2xl font-bold text-white">Edit Email</h3>

			{#if form?.error && (form?.error.includes("email") || form?.error.includes("Email") || form?.error.includes("password"))}
				<div class="mb-4 rounded-lg border border-red-700 bg-red-900/30 p-3 text-sm text-red-300">
					{form.error}
				</div>
			{/if}

			{#if form?.success && form?.message?.includes("Email")}
				<div
					class="mb-4 rounded-lg border border-green-700 bg-green-900/30 p-3 text-sm text-green-300"
				>
					{form.message}
				</div>
			{/if}

			<form
				method="POST"
				action="?/updateEmail"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === "success") {
							await invalidateAll();
							setTimeout(() => closeModals(), 1500);
						}
					};
				}}
			>
				<div class="mb-4">
					<label for="newEmail" class="mb-2 block text-sm font-medium text-gray-300"
						>New Email</label
					>
					<input
						id="newEmail"
						name="email"
						type="email"
						bind:value={newEmail}
						required
						class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white focus:border-theater-purple focus:outline-none"
						placeholder="your@email.com"
					/>
				</div>

				<div class="mb-6">
					<label for="emailPassword" class="mb-2 block text-sm font-medium text-gray-300"
						>Current Password</label
					>
					<input
						id="emailPassword"
						name="password"
						type="password"
						bind:value={emailPassword}
						required
						class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white focus:border-theater-purple focus:outline-none"
						placeholder="Confirm with your password"
					/>
					<p class="mt-1 text-xs text-gray-400">Required to verify your identity</p>
				</div>

				<div class="flex gap-3">
					<button
						type="submit"
						class="flex-1 rounded-lg bg-theater-purple py-3 font-semibold text-white transition hover:bg-purple-700"
					>
						Save Changes
					</button>
					<button
						type="button"
						onclick={closeModals}
						class="flex-1 rounded-lg bg-gray-700 py-3 font-semibold text-white transition hover:bg-gray-600"
					>
						Cancel
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Change Password Modal -->
{#if editingPassword}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
		onclick={(e) => e.target === e.currentTarget && closeModals()}
		role="button"
		tabindex="0"
		onkeydown={(e) => e.key === "Escape" && closeModals()}
	>
		<div class="glass-strong w-full max-w-md rounded-xl p-8 shadow-2xl">
			<h3 class="mb-4 text-2xl font-bold text-white">Change Password</h3>

			{#if form?.error && form?.error.includes("password")}
				<div class="mb-4 rounded-lg border border-red-700 bg-red-900/30 p-3 text-sm text-red-300">
					{form.error}
				</div>
			{/if}

			{#if form?.success && form?.message?.includes("Password")}
				<div
					class="mb-4 rounded-lg border border-green-700 bg-green-900/30 p-3 text-sm text-green-300"
				>
					{form.message}
				</div>
			{/if}

			<form
				method="POST"
				action="?/updatePassword"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === "success") {
							currentPassword = "";
							newPassword = "";
							confirmPassword = "";
							setTimeout(() => closeModals(), 1500);
						}
					};
				}}
			>
				<div class="mb-4">
					<label for="currentPassword" class="mb-2 block text-sm font-medium text-gray-300"
						>Current Password</label
					>
					<input
						id="currentPassword"
						name="currentPassword"
						type="password"
						bind:value={currentPassword}
						required
						class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white focus:border-theater-purple focus:outline-none"
						placeholder="Enter current password"
					/>
				</div>

				<div class="mb-4">
					<label for="newPassword" class="mb-2 block text-sm font-medium text-gray-300"
						>New Password</label
					>
					<input
						id="newPassword"
						name="newPassword"
						type="password"
						bind:value={newPassword}
						required
						minlength="8"
						class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white focus:border-theater-purple focus:outline-none"
						placeholder="At least 8 characters"
					/>
				</div>

				<div class="mb-6">
					<label for="confirmPassword" class="mb-2 block text-sm font-medium text-gray-300"
						>Confirm New Password</label
					>
					<input
						id="confirmPassword"
						name="confirmPassword"
						type="password"
						bind:value={confirmPassword}
						required
						minlength="8"
						class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white focus:border-theater-purple focus:outline-none"
						placeholder="Re-enter new password"
					/>
				</div>

				<div class="flex gap-3">
					<button
						type="submit"
						class="flex-1 rounded-lg bg-theater-purple py-3 font-semibold text-white transition hover:bg-purple-700"
					>
						Change Password
					</button>
					<button
						type="button"
						onclick={closeModals}
						class="flex-1 rounded-lg bg-gray-700 py-3 font-semibold text-white transition hover:bg-gray-600"
					>
						Cancel
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
