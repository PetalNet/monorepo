<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	
	let { data, form } = $props();
	
	let showDeleteConfirm = $state(false);
	let deleteConfirmText = $state('');
	
	// Edit modals
	let editingName = $state(false);
	let editingEmail = $state(false);
	let editingPassword = $state(false);
	
	// Form values
	let newName = $state('');
	let newEmail = $state('');
	let emailPassword = $state('');
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	
	// Success/error messages
	let nameMessage = $state('');
	let emailMessage = $state('');
	let passwordMessage = $state('');
	
	function openNameEdit() {
		newName = data.user.name;
		editingName = true;
		nameMessage = '';
	}
	
	function openEmailEdit() {
		newEmail = data.user.email;
		emailPassword = '';
		editingEmail = true;
		emailMessage = '';
	}
	
	function openPasswordEdit() {
		currentPassword = '';
		newPassword = '';
		confirmPassword = '';
		editingPassword = true;
		passwordMessage = '';
	}
	
	function closeModals() {
		editingName = false;
		editingEmail = false;
		editingPassword = false;
	}
</script>

<div class="min-h-screen p-4 md:p-8">
	<div class="max-w-4xl mx-auto">
		<!-- Header -->
		<div class="mb-8">
			<button 
				onclick={() => goto('/dashboard')}
				class="text-gray-400 hover:text-white mb-4 flex items-center gap-2"
			>
				← Back to Dashboard
			</button>
			<h1 class="text-4xl font-bold mb-2">Account Settings</h1>
			<p class="text-gray-400">Manage your account preferences</p>
		</div>

		<!-- Account Information -->
		<div class="bg-theater-dark rounded-xl p-6 shadow-lg border border-gray-800 mb-6">
			<h2 class="text-2xl font-semibold mb-6">Account Information</h2>
			
			<div class="space-y-6">
				<div>
					<label for="name" class="block text-sm font-medium text-gray-300 mb-2">Name</label>
					<div class="flex items-center gap-4">
						<input 
							id="name"
							type="text" 
							value={data.user.name}
							disabled
							class="flex-1 px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white"
						/>
						<button 
							onclick={openNameEdit}
							class="px-4 py-2 bg-theater-purple hover:bg-purple-700 text-white rounded-lg transition"
						>
							Edit
						</button>
					</div>
				</div>

				<div>
					<label for="email" class="block text-sm font-medium text-gray-300 mb-2">Email</label>
					<div class="flex items-center gap-4">
						<input 
							id="email"
							type="email" 
							value={data.user.email}
							disabled
							class="flex-1 px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white"
						/>
						<button 
							onclick={openEmailEdit}
							class="px-4 py-2 bg-theater-purple hover:bg-purple-700 text-white rounded-lg transition"
						>
							Edit
						</button>
					</div>
				</div>

				<div>
					<label for="password" class="block text-sm font-medium text-gray-300 mb-2">Password</label>
					<div class="flex items-center gap-4">
						<input 
							id="password"
							type="password" 
							value="••••••••••••"
							disabled
							class="flex-1 px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white"
						/>
						<button 
							onclick={openPasswordEdit}
							class="px-4 py-2 bg-theater-purple hover:bg-purple-700 text-white rounded-lg transition"
						>
							Change
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Preferences -->
		<div class="bg-theater-dark rounded-xl p-6 shadow-lg border border-gray-800 mb-6">
			<h2 class="text-2xl font-semibold mb-6">Preferences</h2>
			
			<div class="space-y-4">
				<div class="flex items-center justify-between py-3">
					<div>
						<h3 class="text-white font-medium">Dark Mode</h3>
						<p class="text-sm text-gray-400">Always enabled for the best theater experience</p>
					</div>
					<div class="relative inline-flex h-6 w-11 items-center rounded-full bg-theater-purple">
						<span class="translate-x-6 inline-block h-4 w-4 transform rounded-full bg-white"></span>
					</div>
				</div>
			</div>
		</div>

		<!-- Danger Zone -->
		<div class="bg-red-950/20 border border-red-900/50 rounded-xl p-6 shadow-lg">
			<h2 class="text-2xl font-semibold mb-4 text-red-400">Danger Zone</h2>
			
			<div class="space-y-4">
				<div class="py-4">
					<div class="flex items-start justify-between mb-4">
						<div class="flex-1">
							<h3 class="text-white font-medium mb-2">Delete Account</h3>
							<p class="text-sm text-gray-400 mb-2">Permanently delete your account and all associated data. This action cannot be undone.</p>
							<p class="text-sm text-red-400">⚠️ This will delete:</p>
							<ul class="text-sm text-gray-400 list-disc list-inside ml-2 mt-1">
								<li>All events you've hosted</li>
								<li>All presentation registrations</li>
								<li>All votes and submissions</li>
								<li>Your account information</li>
							</ul>
						</div>
						<button 
							onclick={() => showDeleteConfirm = true}
							class="px-4 py-2 bg-red-900/50 text-red-300 rounded-lg hover:bg-red-900 transition"
						>
							Delete Account
						</button>
					</div>
				</div>
			</div>

		</div>
	</div>
</div>

<!-- Delete Account Confirmation Modal -->
{#if showDeleteConfirm}
	<div class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
		<div class="bg-theater-dark border border-red-900/50 rounded-xl p-8 max-w-md w-full shadow-2xl">
			<h3 class="text-2xl font-bold text-red-400 mb-4">⚠️ Delete Account</h3>
			
			<p class="text-white mb-4">
				This will permanently delete your account and all associated data. This action cannot be undone.
			</p>
			
			<div class="bg-red-950/30 border border-red-900/50 rounded-lg p-4 mb-6">
				<p class="text-sm text-red-300 mb-3">To confirm, type <strong>DELETE</strong> below:</p>
				<input
					type="text"
					bind:value={deleteConfirmText}
					placeholder="Type DELETE"
					class="w-full px-4 py-2 bg-theater-darker border border-red-700 rounded-lg text-white focus:outline-none focus:border-red-500"
				/>
			</div>
			
			<form method="POST" action="?/deleteAccount" use:enhance class="space-y-3">
				<button
					type="submit"
					disabled={deleteConfirmText !== 'DELETE'}
					class="w-full py-3 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition"
				>
					Permanently Delete Account
				</button>
				<button
					type="button"
					onclick={() => {
						showDeleteConfirm = false;
						deleteConfirmText = '';
					}}
					class="w-full py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition"
				>
					Cancel
				</button>
			</form>
		</div>
	</div>
{/if}

<!-- Edit Name Modal -->
{#if editingName}
	<div class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50" onclick={(e) => e.target === e.currentTarget && closeModals()} role="button" tabindex="0" onkeydown={(e) => e.key === 'Escape' && closeModals()}>
		<div class="bg-theater-dark border border-gray-800 rounded-xl p-8 max-w-md w-full shadow-2xl">
			<h3 class="text-2xl font-bold text-white mb-4">Edit Name</h3>
			
			{#if form?.error && form?.error.includes('name')}
				<div class="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
					{form.error}
				</div>
			{/if}
			
			{#if form?.success && form?.message?.includes('Name')}
				<div class="mb-4 p-3 bg-green-900/30 border border-green-700 rounded-lg text-green-300 text-sm">
					{form.message}
				</div>
			{/if}
			
			<form 
				method="POST" 
				action="?/updateName" 
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === 'success') {
							await invalidateAll();
							setTimeout(() => closeModals(), 1500);
						}
					};
				}}
			>
				<div class="mb-6">
					<label for="newName" class="block text-sm font-medium text-gray-300 mb-2">New Name</label>
					<input
						id="newName"
						name="name"
						type="text"
						bind:value={newName}
						required
						class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white focus:outline-none focus:border-theater-purple"
						placeholder="Your name"
					/>
				</div>
				
				<div class="flex gap-3">
					<button
						type="submit"
						class="flex-1 py-3 bg-theater-purple hover:bg-purple-700 text-white rounded-lg font-semibold transition"
					>
						Save Changes
					</button>
					<button
						type="button"
						onclick={closeModals}
						class="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition"
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
	<div class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50" onclick={(e) => e.target === e.currentTarget && closeModals()} role="button" tabindex="0" onkeydown={(e) => e.key === 'Escape' && closeModals()}>
		<div class="bg-theater-dark border border-gray-800 rounded-xl p-8 max-w-md w-full shadow-2xl">
			<h3 class="text-2xl font-bold text-white mb-4">Edit Email</h3>
			
			{#if form?.error && (form?.error.includes('email') || form?.error.includes('Email') || form?.error.includes('password'))}
				<div class="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
					{form.error}
				</div>
			{/if}
			
			{#if form?.success && form?.message?.includes('Email')}
				<div class="mb-4 p-3 bg-green-900/30 border border-green-700 rounded-lg text-green-300 text-sm">
					{form.message}
				</div>
			{/if}
			
			<form 
				method="POST" 
				action="?/updateEmail" 
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === 'success') {
							await invalidateAll();
							setTimeout(() => closeModals(), 1500);
						}
					};
				}}
			>
				<div class="mb-4">
					<label for="newEmail" class="block text-sm font-medium text-gray-300 mb-2">New Email</label>
					<input
						id="newEmail"
						name="email"
						type="email"
						bind:value={newEmail}
						required
						class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white focus:outline-none focus:border-theater-purple"
						placeholder="your@email.com"
					/>
				</div>
				
				<div class="mb-6">
					<label for="emailPassword" class="block text-sm font-medium text-gray-300 mb-2">Current Password</label>
					<input
						id="emailPassword"
						name="password"
						type="password"
						bind:value={emailPassword}
						required
						class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white focus:outline-none focus:border-theater-purple"
						placeholder="Confirm with your password"
					/>
					<p class="text-xs text-gray-400 mt-1">Required to verify your identity</p>
				</div>
				
				<div class="flex gap-3">
					<button
						type="submit"
						class="flex-1 py-3 bg-theater-purple hover:bg-purple-700 text-white rounded-lg font-semibold transition"
					>
						Save Changes
					</button>
					<button
						type="button"
						onclick={closeModals}
						class="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition"
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
	<div class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50" onclick={(e) => e.target === e.currentTarget && closeModals()} role="button" tabindex="0" onkeydown={(e) => e.key === 'Escape' && closeModals()}>
		<div class="bg-theater-dark border border-gray-800 rounded-xl p-8 max-w-md w-full shadow-2xl">
			<h3 class="text-2xl font-bold text-white mb-4">Change Password</h3>
			
			{#if form?.error && form?.error.includes('password')}
				<div class="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
					{form.error}
				</div>
			{/if}
			
			{#if form?.success && form?.message?.includes('Password')}
				<div class="mb-4 p-3 bg-green-900/30 border border-green-700 rounded-lg text-green-300 text-sm">
					{form.message}
				</div>
			{/if}
			
			<form 
				method="POST" 
				action="?/updatePassword" 
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === 'success') {
							currentPassword = '';
							newPassword = '';
							confirmPassword = '';
							setTimeout(() => closeModals(), 1500);
						}
					};
				}}
			>
				<div class="mb-4">
					<label for="currentPassword" class="block text-sm font-medium text-gray-300 mb-2">Current Password</label>
					<input
						id="currentPassword"
						name="currentPassword"
						type="password"
						bind:value={currentPassword}
						required
						class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white focus:outline-none focus:border-theater-purple"
						placeholder="Enter current password"
					/>
				</div>
				
				<div class="mb-4">
					<label for="newPassword" class="block text-sm font-medium text-gray-300 mb-2">New Password</label>
					<input
						id="newPassword"
						name="newPassword"
						type="password"
						bind:value={newPassword}
						required
						minlength="8"
						class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white focus:outline-none focus:border-theater-purple"
						placeholder="At least 8 characters"
					/>
				</div>
				
				<div class="mb-6">
					<label for="confirmPassword" class="block text-sm font-medium text-gray-300 mb-2">Confirm New Password</label>
					<input
						id="confirmPassword"
						name="confirmPassword"
						type="password"
						bind:value={confirmPassword}
						required
						minlength="8"
						class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white focus:outline-none focus:border-theater-purple"
						placeholder="Re-enter new password"
					/>
				</div>
				
				<div class="flex gap-3">
					<button
						type="submit"
						class="flex-1 py-3 bg-theater-purple hover:bg-purple-700 text-white rounded-lg font-semibold transition"
					>
						Change Password
					</button>
					<button
						type="button"
						onclick={closeModals}
						class="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition"
					>
						Cancel
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
