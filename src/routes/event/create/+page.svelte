<script lang="ts">
	import { goto } from '$app/navigation';
	import { COMMON_TIMEZONES, getUserTimezone } from '$lib/utils/timezone';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	
	let loading = $state(false);
	let error = $state('');
	
	// Form state
	let name = $state('');
	let theme = $state('');
	let description = $state('');
	let submissionDeadline = $state('');
	let maxPresentationTime = $state('');
	let orderMode = $state('random');
	let timezone = $state(getUserTimezone() || 'America/New_York');
	
	// Categories
	let categories = $state([
		{ name: 'Creativity', description: 'How creative and original is the presentation?' },
		{ name: 'Delivery', description: 'How well was it presented?' },
		{ name: 'Entertainment', description: 'How entertaining was it?' }
	]);
	
	function addCategory() {
		categories = [...categories, { name: '', description: '' }];
	}
	
	function removeCategory(index: number) {
		categories = categories.filter((_, i) => i !== index);
	}
	
	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		loading = true;
		error = '';
		
		// Validate categories
		const validCategories = categories.filter(c => c.name.trim() !== '');
		if (validCategories.length === 0) {
			error = 'Please add at least one rating category';
			loading = false;
			return;
		}
		
		const formData = {
			name,
			theme: theme || null,
			description: description || null,
			submissionDeadline: submissionDeadline ? new Date(submissionDeadline).toISOString() : null,
			maxPresentationTime: maxPresentationTime ? parseInt(maxPresentationTime.toString()) : null,
			orderMode,
			timezone,
			categories: validCategories
		};
		
		const response = await fetch('/event/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(formData)
		});
		
		if (response.ok) {
			const data = await response.json();
			goto(`/night/${data.joinCode}`);
		} else {
			const data = await response.json();
			error = data.error || 'An error occurred';
			loading = false;
		}
	}
</script>

<PageContainer maxWidth="3xl">
	<PageHeader 
		title="Create New Event"
		subtitle="Set up your presentation night with all the details"
	/>
	
	<form onsubmit={handleSubmit} class="space-y-6">
		<!-- Basic Info -->
		<div class="glass rounded-xl p-6 space-y-4">
				<h2 class="text-2xl font-semibold mb-4">Basic Information</h2>
				
				<div>
					<label for="name" class="block text-sm font-medium mb-2">Event Name *</label>
					<input 
						id="name"
						type="text" 
						bind:value={name}
						required
						class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
						placeholder="Movie Night 2025"
					/>
				</div>
				
				<div>
					<label for="theme" class="block text-sm font-medium mb-2">Theme (Optional)</label>
					<input 
						id="theme"
						type="text" 
						bind:value={theme}
						class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
						placeholder="Movies, Travel, Food..."
					/>
				</div>
				
				<div>
					<label for="description" class="block text-sm font-medium mb-2">Description (Optional)</label>
					<textarea 
						id="description"
						bind:value={description}
						rows="3"
						class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
						placeholder="What's this event about?"
					></textarea>
				</div>
			</div>
			
			<!-- Timing & Settings -->
			<div class="glass rounded-xl p-6 space-y-4">
				<h2 class="text-2xl font-semibold mb-4">Settings</h2>
				
				<div>
					<label for="timezone" class="block text-sm font-medium mb-2">Event Timezone *</label>
					<select 
						id="timezone"
						bind:value={timezone}
						class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent [color-scheme:dark]"
					>
						{#each COMMON_TIMEZONES as tz}
							<option value={tz.value}>{tz.label}</option>
						{/each}
					</select>
					<p class="text-xs text-gray-500 mt-1">All times for this event will be displayed in this timezone. Deadline will be at {COMMON_TIMEZONES.find(tz => tz.value === timezone)?.label || timezone}.</p>
				</div>
				
				<div>
					<label for="submissionDeadline" class="block text-sm font-medium mb-2">Submission Deadline (optional)</label>
					<input 
						id="submissionDeadline"
						type="datetime-local" 
						bind:value={submissionDeadline}
						class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
					/>
					<p class="text-xs text-gray-500 mt-1">Enter time in <strong>{COMMON_TIMEZONES.find(tz => tz.value === timezone)?.label || timezone}</strong></p>
				</div>				<div>
					<label for="maxTime" class="block text-sm font-medium mb-2">Max Presentation Time (minutes, optional)</label>
					<input 
						id="maxTime"
						type="number" 
						bind:value={maxPresentationTime}
						min="1"
						max="60"
						placeholder="e.g., 5"
						class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
					/>
					<p class="text-xs text-gray-500 mt-1">How long should each presentation be? Leave blank for no limit.</p>
				</div>
				
				<div>
					<label for="orderMode" class="block text-sm font-medium mb-2">Presentation Order *</label>
					<select 
						id="orderMode"
						bind:value={orderMode}
						class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
					>
						<option value="random">Random</option>
						<option value="alphabetical">Alphabetical</option>
					</select>
					<p class="text-xs text-gray-500 mt-1">You can manually reorder presentations later.</p>
				</div>
			</div>
			
			<!-- Rating Categories -->
			<div class="glass rounded-xl p-6 space-y-4">
				<div class="flex justify-between items-center mb-4">
					<h2 class="text-2xl font-semibold">Rating Categories</h2>
					<button 
						type="button"
						onclick={addCategory}
						class="px-3 py-1 text-sm rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-gray-700 hover:bg-gray-600 focus:ring-gray-500"
					>
						+ Add Category
					</button>
				</div>
				<p class="text-sm text-gray-400 mb-4">Define what criteria judges will rate presentations on (1-5 stars)</p>
				
				{#each categories as category, index}
					<div class="p-4 bg-theater-darker rounded-lg border border-gray-700 space-y-3">
						<div class="flex justify-between items-start gap-3">
							<div class="flex-1">
								<label for="cat-name-{index}" class="block text-sm font-medium mb-2">Category Name *</label>
								<input 
									id="cat-name-{index}"
									type="text" 
									bind:value={category.name}
									placeholder="e.g., Creativity, Delivery, Impact"
									class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
								/>
							</div>
							{#if categories.length > 1}
								<button 
									type="button"
									onclick={() => removeCategory(index)}
									class="mt-7 px-3 py-2 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded-lg transition-colors"
									title="Remove category"
								>
									✕
								</button>
							{/if}
						</div>
						<div>
							<label for="cat-desc-{index}" class="block text-sm font-medium mb-2">Description (Optional)</label>
							<input 
								id="cat-desc-{index}"
								type="text" 
								bind:value={category.description}
								placeholder="What should judges consider?"
								class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
							/>
						</div>
					</div>
				{/each}
			</div>
			
			<!-- Error Display -->
			{#if error}
				<div class="bg-red-900/30 border border-red-500 text-red-200 px-4 py-3 rounded-lg">
					{error}
				</div>
			{/if}
			
			<!-- Submit Buttons -->
			<div class="flex gap-3">
				<button 
					type="button"
					onclick={() => goto('/dashboard')}
					class="px-6 py-3 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-gray-700 hover:bg-gray-600 focus:ring-gray-500"
				>
					Cancel
				</button>
				<button 
					type="submit" 
					disabled={loading}
					class="flex-1 px-6 py-3 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-theater-purple hover:bg-purple-600 focus:ring-theater-purple disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{loading ? 'Creating Event...' : 'Create Event'}
			</button>
		</div>
	</form>
</PageContainer>
