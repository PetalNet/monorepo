<script lang="ts">
	import { goto } from '$app/navigation';
	import { invalidateAll } from '$app/navigation';
	import { formatDistanceToNow } from 'date-fns';
	import QRCode from 'qrcode';
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { formatInTimezone, toDateTimeLocal, getTimezoneAbbr } from '$lib/utils/timezone';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	
	let { data } = $props();
	let qrCodeUrl = $state('');
	let editingCategories = $state(false);
	let showEditModal = $state(false);
	
	const event = $derived(data.event);
	const submissionsOpen = $derived(!event.submissionsClosed);
	const joinUrl = $derived(`${typeof window !== 'undefined' ? window.location.origin : ''}/night/${event.joinCode}`);
	
	// Categories for reordering
	let categories = $state<any[]>([]);
	let draggedIndex = $state<number | null>(null)
	
	// Start editing categories
	function startEditingCategories() {
		categories = [...event.categories];
		editingCategories = true;
	}
	
	// Cancel category editing
	function cancelCategoryEditing() {
		editingCategories = false;
		categories = [];
	}
	
	// Handle drag and drop
	function handleDragStart(index: number) {
		draggedIndex = index;
	}
	
	function handleDragOver(e: DragEvent, index: number) {
		e.preventDefault();
		if (draggedIndex === null || draggedIndex === index) return;
		
		const newCategories = [...categories];
		const draggedItem = newCategories[draggedIndex];
		newCategories.splice(draggedIndex, 1);
		newCategories.splice(index, 0, draggedItem);
		
		categories = newCategories;
		draggedIndex = index;
	}
	
	function handleDragEnd() {
		draggedIndex = null;
	}
	
	// Save category order
	async function saveCategoryOrder() {
		const response = await fetch(`/event/${event.id}/settings`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'reorderCategories',
				categories: categories.map((cat, index) => ({
					id: cat.id,
					order: index
				}))
			})
		});
		
		if (response.ok) {
			editingCategories = false;
			categories = [];
			// Reload data properly
			await invalidateAll();
		}
	}
	
	onMount(async () => {
		qrCodeUrl = await QRCode.toDataURL(joinUrl, {
			width: 300,
			margin: 2,
			color: {
				dark: '#8b5cf6',
				light: '#0a0a0f'
			}
		});
	});
	
	function copyJoinCode() {
		navigator.clipboard.writeText(event.joinCode);
		alert('Join code copied to clipboard!');
	}
	
	function copyJoinUrl() {
		navigator.clipboard.writeText(joinUrl);
		alert('Join URL copied to clipboard!');
	}
	
	function getStatusBadge(status: string) {
		const badges = {
			setup: { emoji: '📝', text: 'Setup', color: 'bg-blue-900/30 text-blue-300 border-blue-700' },
			live: { emoji: '🔴', text: 'Live', color: 'bg-red-900/30 text-red-300 border-red-700' },
			voting: { emoji: '⭐', text: 'Voting', color: 'bg-yellow-900/30 text-yellow-300 border-yellow-700' },
			completed: { emoji: '✅', text: 'Completed', color: 'bg-green-900/30 text-green-300 border-green-700' }
		};
		return badges[status as keyof typeof badges] || badges.setup;
	}
	
	async function toggleSubmissions() {
		const response = await fetch(`/event/${event.id}/settings`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ 
				action: 'toggleSubmissions',
				submissionsClosed: submissionsOpen
			})
		});
		
		if (response.ok) {
			await invalidateAll();
		}
	}
	
	const statusBadge = $derived(getStatusBadge(event.status));
</script>

<PageContainer maxWidth="7xl">
	<PageHeader 
		title={event.name}
		backLink="/dashboard"
	>
		<span class="px-3 py-1 rounded-full border {statusBadge.color} text-sm font-semibold">
			{statusBadge.emoji} {statusBadge.text}
		</span>
	</PageHeader>
	
	<div class="grid lg:grid-cols-3 gap-6">
		<!-- Main Content -->
		<div class="lg:col-span-2 space-y-6">
				<!-- Event Details / Settings -->
				<div class="glass rounded-xl p-6">
					<div class="flex justify-between items-center mb-4">
						<h2 class="text-2xl font-semibold">Event Settings</h2>
						{#if data.isHost}
							<div class="flex gap-2">
								<button 
									onclick={() => showEditModal = true}
									class="px-4 py-2 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-gray-700 hover:bg-gray-600 focus:ring-gray-500 text-sm"
								>
									✏️ Edit
								</button>
								<form method="POST" action="?/deleteEvent" use:enhance>
									<button 
										type="submit"
										onclick={(e) => {
											if (!confirm('Are you sure you want to delete this event? This will permanently delete all groups, submissions, votes, and other data. This cannot be undone.')) {
												e.preventDefault();
											}
										}}
										class="px-4 py-2 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-red-600 hover:bg-red-700 focus:ring-red-500 text-sm"
									>
										🗑️ Delete Event
									</button>
								</form>
							</div>
						{/if}
					</div>
					
					<div class="space-y-4">
						<div class="grid md:grid-cols-2 gap-4">
							<div>
								<p class="text-sm text-gray-400">Host</p>
								<p class="text-lg">{event.host.name}</p>
							</div>
							<div>
								<p class="text-sm text-gray-400">Submission Deadline</p>
								<p class="text-lg">
									{#if event.submissionDeadline}
										{formatInTimezone(event.submissionDeadline, event.timezone)} {getTimezoneAbbr(event.timezone)}
									{:else}
										No deadline
									{/if}
								</p>
							</div>
							<div>
								<p class="text-sm text-gray-400">Max Presentation Time</p>
								<p class="text-lg">{event.maxPresentationTime ? `${event.maxPresentationTime} minutes` : 'Unlimited'}</p>
							</div>
							<div>
								<p class="text-sm text-gray-400">Presentation Order</p>
								<p class="text-lg capitalize">{event.orderMode}</p>
							</div>
							<div>
								<p class="text-sm text-gray-400">Groups Registered</p>
								<p class="text-lg">{event.groups.length}</p>
							</div>
							<div>
								<p class="text-sm text-gray-400">Submissions</p>
								<p class="text-lg">{submissionsOpen ? '✅ Open' : '🔒 Closed'}</p>
							</div>
						</div>
						
						{#if data.isHost}
							<div class="pt-4 border-t border-gray-700">
								<button 
									onclick={toggleSubmissions}
									class="w-full px-6 py-3 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker {submissionsOpen ? 'bg-red-900/30 hover:bg-red-900/50 text-red-300 border-2 border-red-700 focus:ring-red-500' : 'bg-green-900/30 hover:bg-green-900/50 text-green-300 border-2 border-green-700 focus:ring-green-500'}"
								>
									{submissionsOpen ? '🔒 Close Submissions' : '🔓 Open Submissions'}
								</button>
							</div>
						{/if}
					</div>
				</div>
				
				<!-- Rating Categories -->
				<div class="glass rounded-xl p-6">
					<div class="flex justify-between items-center mb-4">
						<h2 class="text-2xl font-semibold">Rating Categories</h2>
						{#if data.isHost && !editingCategories}
							<button 
								onclick={startEditingCategories}
								class="px-4 py-2 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-gray-700 hover:bg-gray-600 focus:ring-gray-500 text-sm"
							>
								↕️ Reorder
							</button>
						{/if}
					</div>
					
					{#if editingCategories}
						<div class="space-y-3">
							<p class="text-sm text-gray-400 mb-3">Drag and drop to reorder categories</p>
							{#each categories as category, index}
								<div 
									role="button"
									tabindex="0"
									draggable="true"
									ondragstart={() => handleDragStart(index)}
									ondragover={(e) => handleDragOver(e, index)}
									ondragend={handleDragEnd}
									class="p-4 bg-theater-darker rounded-lg border border-gray-700 cursor-move hover:border-theater-purple transition-colors {draggedIndex === index ? 'opacity-50' : ''}"
								>
									<div class="flex items-center gap-3">
										<span class="text-gray-500">⋮⋮</span>
										<div class="flex-1">
											<h3 class="font-semibold text-lg mb-1">{category.name}</h3>
											{#if category.description}
												<p class="text-sm text-gray-400">{category.description}</p>
											{/if}
										</div>
									</div>
								</div>
							{/each}
							<div class="flex gap-3 pt-2">
								<button 
									onclick={saveCategoryOrder}
									class="flex-1 px-6 py-3 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-theater-purple hover:bg-purple-600 focus:ring-theater-purple"
								>
									💾 Save Order
								</button>
								<button 
									onclick={cancelCategoryEditing}
									class="px-6 py-3 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-gray-700 hover:bg-gray-600 focus:ring-gray-500"
								>
									Cancel
								</button>
							</div>
						</div>
					{:else}
						<div class="space-y-3">
							{#each event.categories as category}
								<div class="p-4 bg-theater-darker rounded-lg border border-gray-700">
									<h3 class="font-semibold text-lg mb-1">{category.name}</h3>
									{#if category.description}
										<p class="text-sm text-gray-400">{category.description}</p>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
				
				<!-- Groups -->
				<div class="glass rounded-xl p-6">
					<div class="flex justify-between items-center mb-4">
						<h2 class="text-2xl font-semibold">Registered Groups ({event.groups.length})</h2>
						<span class="text-sm text-gray-400">
							{event.groups.filter(g => g.status === 'submitted').length} submitted
						</span>
					</div>
					{#if event.groups.length === 0}
						<p class="text-gray-400 text-center py-8">No groups have registered yet.</p>
					{:else}
						<div class="space-y-3">
							{#each event.groups as group}
								<div class="p-5 bg-theater-darker rounded-lg border border-gray-700 hover:border-gray-600 transition">
									<div class="flex justify-between items-start mb-3">
										<div class="flex-1">
											<h3 class="font-semibold text-lg mb-1">
												{group.emoji || '📊'} {group.name}
											</h3>
											<div class="flex items-center gap-3 text-sm">
												<span class="text-gray-400">
													👥 {group.members.length} member{group.members.length !== 1 ? 's' : ''}
												</span>
												{#if group.presentationType}
													<span class="text-gray-400">
														🎭 {group.presentationType}
													</span>
												{/if}
											</div>
										</div>
										<span class="text-xs px-3 py-1.5 rounded-full font-semibold {group.status === 'submitted' ? 'bg-green-900/30 border border-green-500/30 text-green-300' : 'bg-gray-800 border border-gray-700 text-gray-400'}">
											{group.status === 'submitted' ? '✅ Submitted' : '⏳ Pending'}
										</span>
									</div>
									
									<!-- Member List -->
									<div class="mb-3">
										<p class="text-xs text-gray-500 mb-2 uppercase tracking-wide">Team Members</p>
										<div class="flex flex-wrap gap-2">
											{#each group.members as member}
												<span class="px-2 py-1 bg-theater-dark rounded text-sm border border-gray-700">
													{#if member.isLeader}
														<span class="text-purple-400">👑</span>
													{/if}
													{member.user.name}
												</span>
											{/each}
										</div>
									</div>
									
									<!-- Submission Info -->
									{#if group.status === 'submitted'}
										<div class="pt-3 border-t border-gray-700">
											{#if group.submissionLink}
												<div class="flex items-start gap-2">
													<span class="text-green-400 text-sm">🔗</span>
													<a 
														href={group.submissionLink}
														target="_blank"
														class="text-sm text-blue-400 hover:text-blue-300 underline break-all flex-1"
													>
														{group.submissionLink}
													</a>
												</div>
											{/if}
											{#if group.submittedAt}
												<p class="text-xs text-gray-500 mt-2">
													Submitted {formatDistanceToNow(new Date(group.submittedAt))} ago
												</p>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>
			
			<!-- Sidebar -->
			<div class="space-y-6">
				<!-- Join Information -->
				<div class="glass rounded-xl p-6">
					<h2 class="text-xl font-semibold mb-4">Join Information</h2>
					
					<div class="space-y-4">
						<!-- Join Code -->
						<div>
							<p class="text-sm text-gray-400 mb-2">Event Code</p>
							<div class="flex gap-2">
								<code class="flex-1 px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-theater-purple font-mono text-lg">
									{event.joinCode}
								</code>
								<button 
									onclick={copyJoinCode}
									class="px-4 py-2 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-gray-700 hover:bg-gray-600 focus:ring-gray-500"
									title="Copy code"
								>
									📋
								</button>
							</div>
						</div>
						
						<!-- Join URL -->
						<div>
							<p class="text-sm text-gray-400 mb-2">Join URL</p>
							<div class="flex gap-2">
								<input 
									type="text" 
									readonly 
									value={joinUrl}
									class="flex-1 px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-gray-300 text-sm"
								/>
								<button 
									onclick={copyJoinUrl}
									class="px-4 py-2 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-gray-700 hover:bg-gray-600 focus:ring-gray-500"
									title="Copy URL"
								>
									📋
								</button>
							</div>
						</div>
						
						<!-- QR Code -->
						{#if qrCodeUrl}
							<div class="text-center">
								<p class="text-sm text-gray-400 mb-3">Scan to Join</p>
								<img src={qrCodeUrl} alt="QR Code" class="mx-auto rounded-lg border-2 border-theater-purple" />
							</div>
						{/if}
					</div>
				</div>
				
				<!-- Quick Stats -->
				<div class="glass rounded-xl p-6">
					<h2 class="text-xl font-semibold mb-4">Stats</h2>
					<div class="space-y-3">
						<div class="flex justify-between">
							<span class="text-gray-400">Total Groups</span>
							<span class="font-semibold">{event.groups.length}</span>
						</div>
						<div class="flex justify-between text-sm pl-4">
							<span class="text-gray-500">✅ Submitted</span>
							<span class="text-green-400 font-semibold">{event.groups.filter(g => g.status === 'submitted').length}</span>
						</div>
						<div class="flex justify-between text-sm pl-4">
							<span class="text-gray-500">⏳ Pending</span>
							<span class="text-gray-400 font-semibold">{event.groups.filter(g => g.status !== 'submitted').length}</span>
						</div>
						<div class="border-t border-gray-700 pt-3 mt-3"></div>
						<div class="flex justify-between">
							<span class="text-gray-400">Total Presenters</span>
							<span class="font-semibold">{event.groups.reduce((sum, g) => sum + g.members.length, 0)}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-gray-400">Judges</span>
							<span class="font-semibold">{event.judges.length}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-gray-400">Categories</span>
							<span class="font-semibold">{event.categories.length}</span>
						</div>
						<div class="border-t border-gray-700 pt-3 mt-3"></div>
						<div class="flex justify-between">
							<span class="text-gray-400">Created</span>
							<span class="font-semibold">{formatDistanceToNow(new Date(event.createdAt))} ago</span>
						</div>
					</div>
				</div>
			</div>
		</div>
</PageContainer>

<!-- Edit Settings Modal -->
{#if showEditModal}
	<div 
		class="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50"
		onclick={(e) => { if (e.target === e.currentTarget) showEditModal = false; }}
	>
		<div class="glass rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-gray-800">
			<h2 class="text-2xl font-semibold mb-6">Edit Event Settings</h2>
			
			<form 
				method="POST" 
				action="?/updateSettings" 
				use:enhance={() => {
					return async ({ result }) => {
						if (result.type === 'success') {
							await invalidateAll();
							showEditModal = false;
						} else if (result.type === 'failure') {
							alert(result.data?.error || 'Failed to update settings');
						}
					};
				}}
			>
				<div class="space-y-4">
					<div>
						<label for="modal-name" class="block text-sm font-medium text-gray-300 mb-2">Event Name</label>
						<input 
							type="text" 
							id="modal-name" 
							name="name" 
							defaultValue={event.name}
							required
							class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
						/>
					</div>
					
					<div>
						<label for="modal-theme" class="block text-sm font-medium text-gray-300 mb-2">Theme (optional)</label>
						<input 
							type="text" 
							id="modal-theme" 
							name="theme" 
							defaultValue={event.theme ?? ''}
							class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
						/>
					</div>
					
					<div>
						<label for="modal-description" class="block text-sm font-medium text-gray-300 mb-2">Description (optional)</label>
						<textarea 
							id="modal-description" 
							name="description" 
							defaultValue={event.description ?? ''}
							rows="3"
							class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
						></textarea>
					</div>
					
					<div class="grid md:grid-cols-2 gap-4">
						<div>
							<label for="modal-deadline" class="block text-sm font-medium text-gray-300 mb-2">Submission Deadline (in {getTimezoneAbbr(event.timezone)})</label>
							<input 
								type="datetime-local" 
								id="modal-deadline" 
								name="submissionDeadline" 
								defaultValue={event.submissionDeadline ? toDateTimeLocal(event.submissionDeadline, event.timezone) : ''}
								class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent [color-scheme:dark]"
							/>
						</div>
						
						<div>
							<label for="modal-time" class="block text-sm font-medium text-gray-300 mb-2">Max Time (minutes, optional)</label>
							<input 
								type="number" 
								id="modal-time" 
								name="maxPresentationTime" 
								defaultValue={event.maxPresentationTime ?? ''}
								min="1"
								class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
							/>
						</div>
					</div>
					
					<div>
						<label for="modal-order" class="block text-sm font-medium text-gray-300 mb-2">Presentation Order</label>
						<select 
							id="modal-order" 
							name="orderMode" 
							value={event.orderMode}
							class="w-full px-4 py-2 bg-theater-darker border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
						>
							<option value="random">Random</option>
							<option value="alphabetical">Alphabetical</option>
						</select>
					</div>
					
					<div class="flex gap-3 pt-4">
						<button 
							type="submit"
							class="flex-1 px-6 py-3 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-theater-purple hover:bg-purple-600 focus:ring-theater-purple"
						>
							💾 Save Changes
						</button>
						<button 
							type="button"
							onclick={() => showEditModal = false}
							class="px-6 py-3 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-gray-700 hover:bg-gray-600 focus:ring-gray-500"
						>
							Cancel
						</button>
					</div>
			</div>
		</form>
	</div>
</div>
{/if}
