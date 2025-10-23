<script lang="ts">
	import { enhance, applyAction } from '$app/forms';
	import { format } from 'date-fns';
	import { goto, invalidateAll } from '$app/navigation';
	import QRCode from 'qrcode';
	import { onMount } from 'svelte';
	import Sortable from 'sortablejs';
	import { formatInTimezone, toDateTimeLocal, getTimezoneAbbr, COMMON_TIMEZONES } from '$lib/utils/timezone';

	let { data, form } = $props();

	// ✨ Simplified UI state
	let uiMode = $state<'none' | 'create' | 'join'>('none');
	let managedGroupId = $state<string | null>(null);
	let activeTab = $state<'members' | 'presentation' | 'danger'>('members');
	let showHostSettings = $state(false);
	let qrCodeUrl = $state('');
	let showCreateModal = $state(false);
	let showJoinModal = $state(false);
	let showCategoriesModal = $state(false);
	let hostPresentationListElement = $state<HTMLElement | null>(null);
	let editingCategories = $state<Array<{id?: string, name: string, description: string, order: number}>>([]);

	// Emoji picker state for create/edit
	let selectedEmoji = $state('📊');
	let editEmoji = $state('📊');
	let editName = $state('');

	const emojiOptions = ['📊', '🎤', '🎬', '🎨', '🎯', '🚀', '💡', '⭐', '🔥', '✨', '🎪', '🎭', '🎸', '🎮', '💻', '📱'];

	const joinUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/night/${data.event.joinCode}`;

	onMount(async () => {
		if (data.isHost) {
			qrCodeUrl = await QRCode.toDataURL(joinUrl, {
				width: 300,
				margin: 2,
				color: {
					dark: '#8b5cf6',
					light: '#0a0a0f'
				}
			});

			// Setup sortable for host presentations list when in host mode
			// Use setTimeout to ensure the element is rendered
			setTimeout(() => {
				if (hostPresentationListElement && data.event.groups.length > 0) {
					Sortable.create(hostPresentationListElement, {
						animation: 150,
						handle: '.drag-handle-host',
						ghostClass: 'opacity-50',
						onEnd: async (evt) => {
							if (evt.oldIndex !== evt.newIndex && evt.oldIndex !== undefined && evt.newIndex !== undefined) {
								await handleReorder(evt.oldIndex, evt.newIndex);
							}
						}
					});
				}
			}, 100);
		}
	});

	function copyJoinCode() {
		navigator.clipboard.writeText(data.event.joinCode);
		alert('Join code copied!');
	}

	function copyJoinUrl() {
		navigator.clipboard.writeText(joinUrl);
		alert('Join URL copied!');
	}

	function getGroupStatus(group: any) {
		if (group.status === 'submitted') return { text: '✅ Submitted', color: 'bg-green-900/30 border-green-500/30 text-green-300' };
		if ((data.event as any).submissionsClosed || data.deadlinePassed) return { text: '🔒 Closed', color: 'bg-yellow-900/30 border-yellow-500/30 text-yellow-300' };
		return { text: '⏳ Pending', color: 'bg-gray-800 border-gray-700 text-gray-400' };
	}

	function getMemberBadge(isLeader: boolean, isYou: boolean) {
		if (isLeader && isYou) return { text: '👑 You (Leader)', color: 'bg-gradient-to-r from-yellow-500 to-purple-600 text-white font-bold' };
		if (isLeader) return { text: '⭐ Leader', color: 'bg-theater-purple text-white' };
		if (isYou) return { text: '🎤 You', color: 'bg-blue-600 text-white font-semibold' };
		return { text: '👤 Member', color: 'bg-gray-700 text-gray-300' };
	}

	function copyInviteCode(code: string) {
		navigator.clipboard.writeText(code);
		alert(`Invite code copied: ${code}`);
	}

	function openManage(group: any) {
		managedGroupId = group.id;
		activeTab = 'members';
		editEmoji = group.emoji || '📊';
		editName = group.name || '';
	}

	function closeManage() {
		managedGroupId = null;
	}

	function openCreateModal() {
		showCreateModal = true;
	}

	function closeCreateModal() {
		showCreateModal = false;
	}

	function openJoinModal() {
		showJoinModal = true;
	}

	function closeJoinModal() {
		showJoinModal = false;
	}

	function openCategoriesModal() {
		editingCategories = data.event.categories?.length > 0 
			? data.event.categories.map((cat: any) => ({
				id: cat.id,
				name: cat.name,
				description: cat.description || '',
				order: cat.order
			}))
			: [{name: '', description: '', order: 0}];
		showCategoriesModal = true;
	}

	function closeCategoriesModal() {
		showCategoriesModal = false;
	}

	function addCategory() {
		editingCategories = [...editingCategories, {
			name: '',
			description: '',
			order: editingCategories.length
		}];
	}

	function removeCategory(index: number) {
		editingCategories = editingCategories.filter((_, i) => i !== index);
		// Update order
		editingCategories.forEach((cat, idx) => cat.order = idx);
	}

	function moveCategoryUp(index: number) {
		if (index > 0) {
			[editingCategories[index], editingCategories[index - 1]] = [editingCategories[index - 1], editingCategories[index]];
			editingCategories.forEach((cat, idx) => cat.order = idx);
			editingCategories = [...editingCategories];
		}
	}

	function moveCategoryDown(index: number) {
		if (index < editingCategories.length - 1) {
			[editingCategories[index], editingCategories[index + 1]] = [editingCategories[index + 1], editingCategories[index]];
			editingCategories.forEach((cat, idx) => cat.order = idx);
			editingCategories = [...editingCategories];
		}
	}

	async function saveCategories() {
		const formData = new FormData();
		formData.append('categories', JSON.stringify(editingCategories));
		
		const response = await fetch(`/night/${data.event.joinCode}?/updateCategories`, {
			method: 'POST',
			body: formData
		});

		if (response.ok) {
			window.location.reload();
		}
	}

	async function handleReorder(oldIndex: number, newIndex: number) {
		const sortedGroups = [...data.event.groups].sort((a: any, b: any) => (a.presentationOrder || 999) - (b.presentationOrder || 999));
		const orderedGroupIds = sortedGroups.map((g: any) => g.id);
		
		// Reorder the array
		const [movedItem] = orderedGroupIds.splice(oldIndex, 1);
		orderedGroupIds.splice(newIndex, 0, movedItem);

		// Update the presentation order in the data immediately (optimistic update)
		orderedGroupIds.forEach((groupId, index) => {
			const group = data.event.groups.find((g: any) => g.id === groupId);
			if (group) {
				group.presentationOrder = index;
			}
		});

		// Trigger reactivity
		data.event.groups = [...data.event.groups];

		// Save to server in background
		const formData = new FormData();
		formData.append('orderedGroupIds', JSON.stringify(orderedGroupIds));
		
		fetch(`/night/${data.event.joinCode}?/reorderPresentations`, {
			method: 'POST',
			body: formData
		});
	}
</script>

<div class="min-h-screen p-3 md:p-8">
	<div class="max-w-6xl mx-auto space-y-6 md:space-y-8">
		
		<!-- === JOIN EVENT CALL-TO-ACTION (For non-participants) === -->
		{#if !data.user}
			<div class="bg-gradient-to-r from-purple-900/40 via-theater-dark to-purple-900/40 rounded-xl p-6 md:p-8 shadow-lg border-2 border-purple-700 ring-2 ring-purple-700/30">
				<div class="text-center">
					<h2 class="text-2xl sm:text-3xl font-bold mb-3">🎉 You're Invited to Join This Event!</h2>
					<p class="text-gray-300 text-lg mb-6">Sign up or log in to create a presentation and participate</p>
					<div class="flex gap-4 justify-center flex-wrap">
						<a href="/auth/signup?redirectTo=/night/{data.event.joinCode}" class="px-8 py-4 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-bold transition text-lg shadow-lg">
							✨ Sign Up to Join
						</a>
						<a href="/auth/login?redirectTo=/night/{data.event.joinCode}" class="px-8 py-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-bold transition text-lg shadow-lg">
							🔑 Log In
						</a>
					</div>
				</div>
			</div>
		{:else if data.userGroups.length === 0}
			<div class="bg-gradient-to-r from-purple-900/40 via-theater-dark to-purple-900/40 rounded-xl p-6 md:p-8 shadow-lg border-2 border-purple-700 ring-2 ring-purple-700/30">
				<div class="text-center">
					<h2 class="text-2xl sm:text-3xl font-bold mb-3">👋 Ready to Join This Event?</h2>
					<p class="text-gray-300 text-lg mb-6">Create your own presentation or join an existing team to participate</p>
					<div class="flex gap-4 justify-center flex-wrap">
						<button 
							onclick={openCreateModal}
							class="px-8 py-4 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-bold transition text-lg shadow-lg"
						>
							✨ Create Presentation
						</button>
						<button 
							onclick={openJoinModal}
							class="px-8 py-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-bold transition text-lg shadow-lg"
						>
							🤝 Join a Team
						</button>
					</div>
				</div>
			</div>
		{/if}

		<!-- === LIVE STATUS BANNER === -->
		{#if data.event.currentPresentationId || data.event.status === 'completed'}
			<div class="bg-gradient-to-r from-red-900/40 via-theater-dark to-red-900/40 rounded-xl p-4 md:p-6 shadow-lg border-2 {data.event.status === 'completed' ? 'border-green-700' : 'border-red-700'} ring-2 {data.event.status === 'completed' ? 'ring-green-700/30' : 'ring-red-700/30'}">
				<div class="flex flex-col md:flex-row items-center justify-between gap-4">
					<div class="flex items-center gap-3">
						{#if data.event.status === 'completed'}
							<div class="w-3 h-3 bg-green-500 rounded-full"></div>
							<div>
								<h3 class="text-xl font-bold text-white">🏆 Event Completed</h3>
								<p class="text-sm text-gray-300">View the final results</p>
							</div>
						{:else if data.event.currentPresentationId}
							<div class="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
							<div>
								<h3 class="text-xl font-bold text-white">🎬 Presentations In Progress</h3>
								<p class="text-sm text-gray-300">A presentation is currently being shown</p>
							</div>
						{/if}
					</div>
					<a 
						href="/night/{data.event.joinCode}/live"
						class="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold transition-all shadow-lg flex items-center gap-2 whitespace-nowrap"
					>
						<span class="w-2 h-2 bg-white rounded-full animate-pulse"></span>
						{data.event.status === 'completed' ? 'View Results' : 'Join Live Event'}
					</a>
				</div>
			</div>
		{/if}

		<!-- === 1. EVENT OVERVIEW (Always Visible) === -->
		<div class="bg-theater-dark rounded-xl p-4 md:p-8 shadow-lg border border-gray-800">
			<div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4 mb-4">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 mb-1 flex-wrap">
						<h1 class="text-2xl sm:text-3xl md:text-4xl font-bold break-words">{data.event.name}</h1>
						{#if data.isHost}
							<span class="text-xs sm:text-sm px-2 sm:px-3 py-1 bg-purple-900/50 text-purple-300 rounded-full border border-purple-700 whitespace-nowrap">👑 Host</span>
						{/if}
					</div>
					<p class="text-sm sm:text-base text-gray-400">Hosted by {data.event.host.name}</p>
				</div>
				<div class="flex gap-2">
					<a href="/dashboard" class="px-3 py-2 sm:px-4 sm:py-2 bg-theater-purple hover:bg-purple-600 text-white rounded-lg transition text-sm sm:text-base whitespace-nowrap self-start">← Back</a>
				</div>
			</div>
			{#if data.event.theme}
				<p class="text-sm sm:text-base text-gray-300 mb-2"><span class="text-gray-400">Theme:</span> {data.event.theme}</p>
			{/if}
			{#if data.event.description}
				<p class="text-sm sm:text-base text-gray-400 mb-4 sm:mb-6">{data.event.description}</p>
			{/if}
			<div class="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
				<div class="bg-theater-darker rounded-lg p-3 sm:p-4">
					<p class="text-gray-400 text-xs sm:text-sm mb-1">Submissions</p>
					<p class="text-lg sm:text-xl font-bold break-words">
						{#if (data.event as any).submissionsClosed}
							🔒 Closed
						{:else if data.deadlinePassed}
							⏰ Deadline Passed
						{:else}
							✅ Open
						{/if}
					</p>
				</div>
				<div class="bg-theater-darker rounded-lg p-3 sm:p-4">
					<p class="text-gray-400 text-xs sm:text-sm mb-1">Deadline</p>
					<p class="text-sm sm:text-lg font-semibold break-words" class:text-red-400={data.deadlinePassed}>
						{#if data.event.submissionDeadline}
							{formatInTimezone(data.event.submissionDeadline, data.event.timezone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} {getTimezoneAbbr(data.event.timezone)}
							{#if data.deadlinePassed}
								<span class="text-xs text-red-400 block mt-1">(Passed)</span>
							{/if}
						{:else}
							No deadline
						{/if}
					</p>
				</div>
				<div class="bg-theater-darker rounded-lg p-3 sm:p-4">
					<p class="text-gray-400 text-xs sm:text-sm mb-1">Max Time</p>
					<p class="text-lg sm:text-xl font-bold">{data.event.maxPresentationTime ? `${data.event.maxPresentationTime} min` : 'Unlimited'}</p>
				</div>
				<div class="bg-theater-darker rounded-lg p-3 sm:p-4">
					<p class="text-gray-400 text-xs sm:text-sm mb-1">Presentations</p>
					<p class="text-lg sm:text-xl font-bold">{data.event._count?.groups || 0}</p>
				</div>
			</div>
		</div>

		<!-- === 2. HOST MANAGEMENT (Host Only, Collapsible) === -->
		{#if data.isHost}
			<details class="bg-theater-dark rounded-xl p-4 md:p-8 shadow-lg border border-purple-700">
				<summary class="text-xl sm:text-2xl font-bold cursor-pointer flex items-center gap-2 hover:text-purple-300 transition">
					⚙️ Event Management
					<span class="text-xs text-purple-300 bg-purple-900/30 rounded-full px-2 py-0.5">Host Only</span>
				</summary>
				<div class="mt-6 space-y-6">
					
					<!-- QR Code & Join Info -->
					<div class="bg-theater-darker rounded-lg p-4 border border-gray-700">
						<h3 class="text-lg font-semibold mb-4">Share Event</h3>
						<div class="flex flex-col md:flex-row gap-4">
							{#if qrCodeUrl}
								<div class="flex flex-col items-center">
									<img src={qrCodeUrl} alt="Event QR Code" class="rounded-lg w-48 h-48 object-contain" />
									<p class="text-xs text-gray-400 mt-2">Scan to join event</p>
								</div>
							{/if}
							<div class="flex-1 space-y-3">
								<div>
									<label class="text-xs text-gray-400 mb-1 block">
										Join Code
										<div class="flex gap-2 mt-1">
											<code class="flex-1 bg-theater-dark px-4 py-3 rounded text-purple-300 font-mono font-bold text-lg text-center border border-gray-700">{data.event.joinCode}</code>
											<button onclick={copyJoinCode} class="px-4 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded font-semibold transition">📋 Copy</button>
										</div>
									</label>
								</div>
								<div>
									<label class="text-xs text-gray-400 mb-1 block">
										Join URL
										<div class="flex gap-2 mt-1">
											<input readonly value={joinUrl} class="flex-1 bg-theater-dark px-4 py-3 rounded text-gray-300 border border-gray-700 font-mono text-sm" />
											<button onclick={copyJoinUrl} class="px-4 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded font-semibold transition">📋 Copy</button>
										</div>
									</label>
								</div>
								<div class="pt-3">
									<a 
										href="/event/{data.event.id}/live" 
										class="block w-full py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold text-center transition"
									>
										🔴 Go Live
									</a>
								</div>
							</div>
						</div>
					</div>

					<div class="grid md:grid-cols-2 gap-6">
						<!-- Edit Event Settings -->
						<form method="POST" action="?/updateEvent" use:enhance={() => {
							return async ({ result }) => {
								if (result.type === 'success') {
									await invalidateAll();
								} else if (result.type === 'failure') {
									alert(result.data?.error || 'Failed to update settings');
								}
							};
						}} class="bg-theater-darker rounded-lg p-4 border border-gray-700 space-y-4">
							<h3 class="text-lg font-semibold mb-2">Event Settings</h3>
							<label class="block">
								<span class="text-gray-300 mb-1 block text-sm">Event Name</span>
								<input 
									name="name" 
									type="text" 
									required 
									defaultValue={data.event.name} 
									class="w-full bg-theater-dark border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-theater-purple"
								/>
							</label>
							<label class="block">
								<span class="text-gray-300 mb-1 block text-sm">Theme</span>
								<input 
									name="theme" 
									type="text" 
									defaultValue={data.event.theme || ''} 
									class="w-full bg-theater-dark border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-theater-purple"
								/>
							</label>
							<label class="block">
								<span class="text-gray-300 mb-1 block text-sm">Description</span>
								<textarea 
									name="description" 
									rows="3" 
									class="w-full bg-theater-dark border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-theater-purple"
								>{data.event.description || ''}</textarea>
							</label>
							<label class="block">
								<span class="text-gray-300 mb-1 block text-sm">Event Timezone</span>
								<select
									name="timezone" 
									defaultValue={data.event.timezone || 'America/New_York'}
									class="w-full bg-theater-dark border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-theater-purple"
								>
									<option value="America/New_York">Eastern (EST/EDT)</option>
									<option value="America/Chicago">Central (CST/CDT)</option>
									<option value="America/Denver">Mountain (MST/MDT)</option>
									<option value="America/Phoenix">Arizona (MST)</option>
									<option value="America/Los_Angeles">Pacific (PST/PDT)</option>
									<option value="America/Anchorage">Alaska (AKST/AKDT)</option>
									<option value="Pacific/Honolulu">Hawaii (HST)</option>
									<option value="UTC">UTC</option>
									<option value="Europe/London">London (GMT/BST)</option>
									<option value="Europe/Paris">Paris (CET/CEST)</option>
									<option value="Europe/Berlin">Berlin (CET/CEST)</option>
									<option value="Asia/Tokyo">Tokyo (JST)</option>
									<option value="Asia/Shanghai">Shanghai (CST)</option>
									<option value="Asia/Dubai">Dubai (GST)</option>
									<option value="Australia/Sydney">Sydney (AEDT/AEST)</option>
								</select>
								<p class="text-xs text-gray-400 mt-1">All times will be shown in this timezone</p>
							</label>
							<label class="block">
								<span class="text-gray-300 mb-1 block text-sm">Submission Deadline (in {getTimezoneAbbr(data.event.timezone)})</span>
								<input 
									name="submissionDeadline" 
									type="datetime-local"
									defaultValue={data.event.submissionDeadline ? toDateTimeLocal(data.event.submissionDeadline, data.event.timezone) : ''}
									class="w-full bg-theater-dark border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-theater-purple [color-scheme:dark]"
								/>
							</label>
							<label class="block">
								<span class="text-gray-300 mb-1 block text-sm">Max Presentation Time (minutes)</span>
				<input 
									name="maxPresentationTime" 
									type="number" 
									min="0" 
									defaultValue={data.event.maxPresentationTime || ''} 
									class="w-full bg-theater-dark border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-theater-purple"
								/>
							</label>
							<div class="flex items-center gap-3">
								<input 
									name="submissionsClosed" 
									type="checkbox" 
									id="submissionsClosed"
									defaultChecked={(data.event as any).submissionsClosed}
									class="w-4 h-4 text-theater-purple bg-theater-dark border-gray-700 rounded focus:ring-theater-purple"
								/>
								<label for="submissionsClosed" class="text-gray-300 text-sm">Close submissions (prevent new presentations)</label>
							</div>
							<button 
								type="submit" 
								class="w-full py-2 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-semibold transition"
							>
								💾 Save Settings
							</button>
						</form>

						<!-- Manage All Presentations -->
						<div class="bg-theater-darker rounded-lg p-4 border border-gray-700">
							<div class="flex items-center justify-between mb-3">
								<h3 class="text-lg font-semibold">🎯 Presentation Order</h3>
								<span class="text-sm text-gray-400">{data.event.groups.length} total</span>
							</div>
							<p class="text-xs text-gray-400 mb-3">Drag presentations to reorder them for the live event.</p>
							<div bind:this={hostPresentationListElement} class="space-y-2 max-h-96 overflow-y-auto">
								{#if data.event.groups.length === 0}
									<p class="text-gray-400 text-sm text-center py-8">No presentations yet</p>
								{:else}
									{#each [...data.event.groups].sort((a, b) => (a.presentationOrder || 999) - (b.presentationOrder || 999)) as group, idx}
										<div class="flex items-center gap-2 p-3 rounded-lg border border-gray-800 bg-theater-dark hover:border-theater-purple/50 transition cursor-move" data-id={group.id}>
											<button class="drag-handle-host cursor-move text-gray-400 hover:text-purple-300 transition px-1" title="Drag to reorder">
												<span class="text-lg">⋮⋮</span>
											</button>
											<span class="text-gray-400 font-mono text-sm w-8">#{idx + 1}</span>
											<span class="text-xl flex-shrink-0">{group.emoji || '📊'}</span>
											<div class="flex-1 min-w-0">
												<p class="font-semibold text-white truncate">{group.name}</p>
												<div class="flex items-center gap-2 text-xs text-gray-400">
													<span>👥 {group.members?.length || 0}</span>
													<span class="px-2 py-0.5 rounded-full {getGroupStatus(group).color}">{getGroupStatus(group).text}</span>
												</div>
											</div>
										</div>
									{/each}
								{/if}
							</div>
						</div>
					</div>

					<!-- Advanced Management Options -->
					<div class="grid md:grid-cols-2 gap-6 mt-6">
						<!-- Rating Categories -->
						<div class="bg-theater-darker rounded-lg p-4 border border-gray-700">
							<h3 class="text-lg font-semibold mb-3">📊 Rating Categories</h3>
							<div class="space-y-2 mb-4 max-h-60 overflow-y-auto">
								{#if data.event.categories && data.event.categories.length > 0}
									{#each data.event.categories.sort((a: any, b: any) => a.order - b.order) as category}
										<div class="flex items-center gap-2 p-2 rounded-lg border border-gray-800 bg-theater-dark">
											<span class="text-gray-400 text-sm">#{category.order + 1}</span>
											<div class="flex-1 min-w-0">
												<p class="font-semibold text-white text-sm truncate">{category.name}</p>
												{#if category.description}
													<p class="text-xs text-gray-400 truncate">{category.description}</p>
												{/if}
											</div>
										</div>
									{/each}
								{:else}
									<p class="text-gray-400 text-sm text-center py-4">No categories defined</p>
								{/if}
							</div>
							<button 
								onclick={openCategoriesModal}
								class="w-full py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition text-sm"
							>
								⚙️ Manage Categories
							</button>
						</div>

						<!-- Participant Management -->
						<div class="bg-theater-darker rounded-lg p-4 border border-gray-700 md:col-span-2">
							<h3 class="text-lg font-semibold mb-3">� Participant Management</h3>
							{#if data.event.groups.length > 0}
								{@const participantMap = new Map()}
								{#each data.event.groups as group}
									{#each group.members || [] as member}
										{@const existing = participantMap.get(member.user.email)}
										{#if existing}
											{@const _ = existing.groups.push({ id: group.id, name: group.name, emoji: group.emoji, isLeader: member.isLeader })}
										{:else}
											{@const _ = participantMap.set(member.user.email, {
												userId: member.user.id,
												name: member.user.name,
												email: member.user.email,
												groups: [{ id: group.id, name: group.name, emoji: group.emoji, isLeader: member.isLeader }]
											})}
										{/if}
									{/each}
								{/each}
								{@const participants = Array.from(participantMap.values()).sort((a, b) => a.name.localeCompare(b.name))}
								
								<div class="mb-4 grid grid-cols-2 gap-4">
									<div class="bg-theater-dark rounded-lg p-3 border border-gray-800">
										<div class="text-sm text-gray-400">Total Participants</div>
										<div class="text-2xl font-bold text-white">{participants.length}</div>
									</div>
									<div class="bg-theater-dark rounded-lg p-3 border border-gray-800">
										<div class="text-sm text-gray-400">Total Presentations</div>
										<div class="text-2xl font-bold text-white">{data.event.groups.length}</div>
									</div>
								</div>
								
								<div class="space-y-2 max-h-96 overflow-y-auto">
									{#each participants as participant}
										<div class="bg-theater-dark rounded-lg p-3 border border-gray-800">
											<div class="flex items-start justify-between gap-3 mb-2">
												<div class="flex-1 min-w-0">
													<div class="flex items-center gap-2 mb-1">
														<span class="text-lg">👤</span>
														<span class="font-semibold text-white truncate">{participant.name}</span>
													</div>
													<span class="text-xs text-gray-400 truncate block">{participant.email}</span>
												</div>
												<form method="POST" action="?/removeParticipant" use:enhance>
													<input type="hidden" name="userId" value={participant.userId} />
													<button 
														type="submit" 
														class="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs rounded-lg font-semibold transition"
														onclick={(e) => { if (!confirm(`Remove ${participant.name} from all presentations in this event?`)) e.preventDefault(); }}
													>
														🗑️ Remove
													</button>
												</form>
											</div>
											<div class="flex flex-wrap gap-1">
												{#each participant.groups as group}
													<span class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-purple-900/30 border border-purple-700/30 text-xs">
														<span>{group.emoji}</span>
														<span class="text-purple-300">{group.name}</span>
														{#if group.isLeader}
															<span class="text-yellow-300">👑</span>
														{/if}
													</span>
												{/each}
											</div>
										</div>
									{/each}
								</div>
							{:else}
								<p class="text-gray-400 text-sm text-center py-8">No participants yet</p>
							{/if}
						</div>
					</div>
				</div>
			</details>
		{/if}

		<!-- === 3. EVENT PRESENTATIONS (Combined - Your presentations first, then all others) === -->
		<div class="bg-theater-dark rounded-xl p-4 md:p-8 shadow-lg border border-gray-800">
			<div class="flex items-center justify-between mb-6">
				<h2 class="text-xl sm:text-2xl font-bold">📊 Event Presentations</h2>
				{#if data.user && data.userGroups.length > 0}
					<div class="flex gap-2">
						<button 
							onclick={openCreateModal}
							disabled={(data.event as any).submissionsClosed || data.deadlinePassed}
							class="px-3 sm:px-4 py-2 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-semibold transition text-sm sm:text-base whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
							title={(data.event as any).submissionsClosed || data.deadlinePassed ? 'Submissions are closed' : ''}
						>
							✨ Create
						</button>
						<button 
							onclick={openJoinModal}
							disabled={(data.event as any).submissionsClosed || data.deadlinePassed}
							class="px-3 sm:px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition text-sm sm:text-base whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
							title={(data.event as any).submissionsClosed || data.deadlinePassed ? 'Submissions are closed' : ''}
						>
							🤝 Join
						</button>
					</div>
				{/if}
			</div>

			{#if data.deadlinePassed && !data.isHost}
				<div class="mb-6 p-4 bg-red-900/20 border border-red-700/50 rounded-lg">
					<div class="flex items-start gap-3">
						<span class="text-2xl">⏰</span>
						<div>
							<p class="font-semibold text-red-300 mb-1">Submission Deadline Has Passed</p>
							<p class="text-sm text-red-200">New presentations can no longer be created or joined for this event.</p>
						</div>
					</div>
				</div>
			{/if}

			{#if data.event.groups.length === 0}
				<div class="text-center py-12">
					<p class="text-gray-400 text-lg mb-2">No presentations yet</p>
					<p class="text-gray-500 text-sm">Be the first to create a presentation for this event!</p>
				</div>
			{:else}
				{@const userGroupIds = new Set(data.userGroups.map((ug: any) => ug.group.id))}
				{@const sortedGroups = [...data.event.groups].sort((a, b) => {
					const aIsUser = userGroupIds.has(a.id);
					const bIsUser = userGroupIds.has(b.id);
					if (aIsUser && !bIsUser) return -1;
					if (!aIsUser && bIsUser) return 1;
					return 0;
				})}
				
				<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
					{#each sortedGroups as group}
						{@const status = getGroupStatus(group)}
						{@const isUserInGroup = data.user ? userGroupIds.has(group.id) : false}
						{@const userMembership = data.userGroups.find((ug: any) => ug.group.id === group.id)}
						
						{#if isUserInGroup}
							<!-- User's Presentation - Gradient background with manage button -->
							<div class="bg-gradient-to-br from-purple-900/40 via-theater-dark to-theater-dark rounded-xl p-4 sm:p-5 shadow-lg border-2 border-theater-purple ring-2 ring-theater-purple/30 hover:ring-theater-purple/50 transition">
								<div class="flex items-start gap-3 mb-3">
									<span class="text-3xl sm:text-4xl flex-shrink-0">{group.emoji || '📊'}</span>
									<div class="flex-1 min-w-0">
										<h3 class="text-lg sm:text-xl font-bold text-white break-words leading-tight mb-2">{group.name}</h3>
										<div class="flex flex-wrap items-center gap-2 mb-2">
											<span class="text-xs px-2 py-1 rounded-full {status.color}">{status.text}</span>
											{#if userMembership?.isLeader}
												<span class="text-xs px-2 py-1 rounded-full bg-yellow-900/50 text-yellow-300 border border-yellow-700">👑 Leader</span>
											{/if}
											<span class="text-xs px-2 py-1 rounded-full bg-purple-900/50 text-purple-300 border border-purple-700">✨ You're in this</span>
										</div>
									</div>
								</div>
								<div class="border-t border-purple-700/30 pt-3 mb-3">
									<p class="text-sm text-gray-400 mb-2">👥 Team Members ({group.members?.length || 0})</p>
									<div class="space-y-1 max-h-24 overflow-y-auto">
										{#each group.members as member}
											<div class="flex items-center gap-2 text-sm">
												<span>{member.isLeader ? '👑' : '🎤'}</span>
												<span class="text-white truncate flex-1">{member.user.name}</span>
												{#if member.userId === data.user?.id}
													<span class="text-xs text-purple-400">(You)</span>
												{/if}
											</div>
										{/each}
									</div>
								</div>
								<button 
									onclick={() => openManage(group)}
									class="w-full py-2.5 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-bold transition"
								>
									⚙️ Manage Presentation
								</button>
							</div>
						{:else}
							<!-- Other Presentations - Simple display only -->
							<div class="bg-theater-darker rounded-xl p-4 sm:p-5 shadow-lg border border-gray-800 opacity-90">
								<div class="flex items-start gap-3 mb-3">
									<span class="text-3xl sm:text-4xl flex-shrink-0">{group.emoji || '📊'}</span>
									<div class="flex-1 min-w-0">
										<h3 class="text-lg sm:text-xl font-bold text-white break-words leading-tight mb-2">{group.name}</h3>
										<span class="inline-block text-xs px-2 py-1 rounded-full {status.color}">{status.text}</span>
									</div>
								</div>
								<div class="border-t border-gray-700 pt-3">
									<p class="text-sm text-gray-400 mb-2">👥 Team Members ({group.members?.length || 0})</p>
									<div class="space-y-1 max-h-24 overflow-y-auto">
										{#each group.members as member}
											<div class="flex items-center gap-2 text-sm">
												<span>{member.isLeader ? '👑' : '🎤'}</span>
												<span class="text-gray-300 truncate">{member.user.name}</span>
											</div>
										{/each}
									</div>
								</div>
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</div>

		<!-- === CREATE PRESENTATION MODAL === -->
		{#if showCreateModal}
			<div class="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto">
				<button 
					type="button"
					class="fixed inset-0 bg-black/80" 
					onclick={closeCreateModal}
					aria-label="Close create modal"
				></button>
				<div class="relative w-full max-w-lg bg-theater-dark border border-purple-700 rounded-xl shadow-2xl p-6 animate-in fade-in slide-in-from-bottom-4 duration-200">
					<div class="flex items-center justify-between mb-4">
						<h3 class="text-xl sm:text-2xl font-bold flex items-center gap-2">
							<span class="text-2xl">✨</span>
							Create New Presentation
						</h3>
						<button onclick={closeCreateModal} class="text-gray-400 hover:text-white text-2xl">✕</button>
					</div>
					<form method="POST" action="?/createGroup" use:enhance={() => {
						return async ({ result }) => {
							if (result.type === 'success') {
								closeCreateModal();
								await invalidateAll();
							}
						};
					}} class="space-y-4">
						<div>
							<label for="create-emoji-modal" class="text-gray-300 mb-2 block">Emoji (single emoji only)</label>
							<input 
								id="create-emoji-modal"
								type="text" 
								name="emoji" 
								bind:value={selectedEmoji}
								maxlength="2"
								oninput={(e) => {
									const value = e.currentTarget.value;
									const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
									const segments = Array.from(segmenter.segment(value));
									if (segments.length > 1) {
										e.currentTarget.value = segments[0].segment;
										selectedEmoji = segments[0].segment;
									}
								}}
								placeholder="Type or pick emoji"
								class="w-full bg-theater-darker border border-gray-700 rounded-lg px-4 py-3 text-white text-2xl text-center placeholder:text-gray-500 placeholder:text-base focus:outline-none focus:border-theater-purple mb-3"
							/>
							<div class="text-xs text-gray-400 mb-2 text-center">Quick picks:</div>
							<div class="grid grid-cols-8 gap-2 p-3 bg-theater-darker border border-gray-700 rounded-lg">
								{#each emojiOptions as emoji}
									<button type="button" onclick={() => (selectedEmoji = emoji)} class="text-2xl p-2 rounded-lg transition hover:bg-theater-purple/20 {selectedEmoji === emoji ? 'bg-theater-purple ring-2 ring-theater-purple' : 'hover:scale-110'}">{emoji}</button>
								{/each}
							</div>
						</div>
						<div>
							<label for="groupName-modal" class="text-gray-300 mb-2 block">Presentation Name</label>
							<input id="groupName-modal" name="name" type="text" required placeholder="Enter a name for your presentation" class="w-full bg-theater-darker border border-gray-700 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:border-theater-purple" />
						</div>
						{#if form?.error}
							<p class="text-red-400 text-sm">{form.error}</p>
						{/if}
						<div class="flex gap-3">
							<button type="button" onclick={closeCreateModal} class="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition">Cancel</button>
							<button type="submit" class="flex-1 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-bold transition">✨ Create</button>
						</div>
					</form>
				</div>
			</div>
		{/if}

		<!-- === JOIN PRESENTATION MODAL === -->
		{#if showJoinModal}
			<div class="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto">
				<button 
					type="button"
					class="fixed inset-0 bg-black/80" 
					onclick={closeJoinModal}
					aria-label="Close join modal"
				></button>
				<div class="relative w-full max-w-lg bg-theater-dark border border-purple-700 rounded-xl shadow-2xl p-6 animate-in fade-in slide-in-from-bottom-4 duration-200">
					<div class="flex items-center justify-between mb-4">
						<h3 class="text-xl sm:text-2xl font-bold flex items-center gap-2">
							<span class="text-2xl">🤝</span>
							Join a Presentation Team
						</h3>
						<button onclick={closeJoinModal} class="text-gray-400 hover:text-white text-2xl">✕</button>
					</div>
					<form method="POST" action="?/joinGroup" use:enhance={() => {
						return async ({ result }) => {
							if (result.type === 'success') {
								closeJoinModal();
								await invalidateAll();
							}
						};
					}} class="space-y-4">
						<div>
							<label for="inviteCode-modal" class="text-gray-300 mb-2 block">Invite Code</label>
							<input id="inviteCode-modal" name="inviteCode" type="text" required placeholder="Enter 8-character code" maxlength="8" class="w-full bg-theater-darker border border-gray-700 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 font-mono uppercase focus:outline-none focus:border-theater-purple text-center text-xl tracking-widest" />
							<p class="text-gray-400 text-xs mt-2">Get the invite code from your presentation leader.</p>
						</div>
						{#if form?.error}
							<p class="text-red-400 text-sm">{form.error}</p>
						{/if}
						<div class="flex gap-3">
							<button type="button" onclick={closeJoinModal} class="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition">Cancel</button>
							<button type="submit" class="flex-1 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-bold transition">🤝 Join Team</button>
						</div>
					</form>
				</div>
			</div>
		{/if}

		<!-- === CATEGORIES MODAL === -->
		{#if showCategoriesModal}
			<div class="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto">
				<button 
					type="button"
					class="fixed inset-0 bg-black/80" 
					onclick={closeCategoriesModal}
					aria-label="Close categories modal"
				></button>
				<div class="relative w-full max-w-2xl bg-theater-dark border border-purple-700 rounded-xl shadow-2xl p-6 animate-in fade-in slide-in-from-bottom-4 duration-200">
					<div class="flex items-center justify-between mb-4">
						<h3 class="text-xl sm:text-2xl font-bold">📊 Manage Rating Categories</h3>
						<button onclick={closeCategoriesModal} class="text-gray-400 hover:text-white text-2xl">✕</button>
					</div>
					<p class="text-gray-400 text-sm mb-4">Categories will be used for rating presentations during the live event. Reorder them to change the display order.</p>
					
					<div class="space-y-3 max-h-96 overflow-y-auto mb-6">
						{#each editingCategories as category, index}
							<div class="bg-theater-darker rounded-lg p-4 border border-gray-700">
								<div class="flex items-start gap-3 mb-3">
									<div class="flex flex-col gap-1 pt-2">
										<button
											type="button"
											onclick={() => moveCategoryUp(index)}
											disabled={index === 0}
											class="px-2 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded transition text-xs"
											title="Move up"
										>
											▲
										</button>
										<button
											type="button"
											onclick={() => moveCategoryDown(index)}
											disabled={index === editingCategories.length - 1}
											class="px-2 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded transition text-xs"
											title="Move down"
										>
											▼
										</button>
									</div>
									<div class="flex-1 space-y-3">
										<div>
											<label for="category-name-{index}" class="text-gray-300 text-sm mb-1 block">
												Category Name <span class="text-red-400">*</span>
											</label>
											<input 
												id="category-name-{index}"
												type="text" 
												bind:value={category.name}
												placeholder="e.g., Content Quality, Presentation Style"
												required
												class="w-full bg-theater-dark border border-gray-700 rounded-lg px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:border-theater-purple"
											/>
										</div>
										<div>
											<label for="category-desc-{index}" class="text-gray-300 text-sm mb-1 block">
												Description (optional)
											</label>
											<input 
												id="category-desc-{index}"
												type="text" 
												bind:value={category.description}
												placeholder="Brief description of what to rate"
												class="w-full bg-theater-dark border border-gray-700 rounded-lg px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:border-theater-purple"
											/>
										</div>
									</div>
									<button
										type="button"
										onclick={() => removeCategory(index)}
										class="px-3 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition flex-shrink-0"
										title="Remove category"
									>
										🗑️
									</button>
								</div>
							</div>
						{/each}
					</div>

					<button 
						type="button"
						onclick={addCategory}
						class="w-full py-2 mb-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition"
					>
						➕ Add Category
					</button>

					<div class="flex gap-3">
						<button type="button" onclick={closeCategoriesModal} class="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition">Cancel</button>
						<button type="button" onclick={saveCategories} class="flex-1 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-bold transition">💾 Save Categories</button>
					</div>
				</div>
			</div>
		{/if}

		<!-- === GROUP MANAGEMENT DRAWER (modal, unchanged) === -->
		{#if managedGroupId}
			{@const managed = data.userGroups.find((ug: any) => ug.group.id === managedGroupId)}
			{#if managed}
				<div class="fixed inset-0 z-50 flex items-start justify-center p-2 sm:p-4 md:p-8 overflow-y-auto">
					<button 
						type="button"
						class="fixed inset-0 bg-black/80 cursor-default" 
						onclick={closeManage}
						aria-label="Close management panel"
					></button>
					<div class="relative w-full max-w-4xl bg-theater-dark border border-gray-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200 my-auto">
						<div class="flex items-start justify-between p-4 sm:p-6 border-b border-gray-800">
							<div class="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 mr-2">
								<span class="text-2xl sm:text-3xl flex-shrink-0">{managed.group.emoji || '📊'}</span>
								<div class="min-w-0 flex-1">
									<h3 class="text-xl sm:text-2xl font-bold break-words">{managed.group.name}</h3>
									<p class="text-xs sm:text-sm text-gray-400">{managed.group.members.length} member{managed.group.members.length === 1 ? '' : 's'}</p>
								</div>
							</div>
							<button class="text-gray-400 hover:text-white text-xl sm:text-2xl flex-shrink-0 p-1" onclick={closeManage}>✕</button>
						</div>
						<div class="px-3 sm:px-6 pt-3 sm:pt-4">
							<div class="flex gap-1 sm:gap-2 mb-3 sm:mb-4 overflow-x-auto">
								<button class="px-3 sm:px-4 py-2 rounded-lg border text-xs sm:text-base whitespace-nowrap {activeTab === 'members' ? 'border-theater-purple text-white' : 'border-gray-700 text-gray-300'}" onclick={() => (activeTab = 'members')}>Members</button>
								<button class="px-3 sm:px-4 py-2 rounded-lg border text-xs sm:text-base whitespace-nowrap {activeTab === 'presentation' ? 'border-theater-purple text-white' : 'border-gray-700 text-gray-300'}" onclick={() => (activeTab = 'presentation')}>Presentation</button>
								<button class="px-3 sm:px-4 py-2 rounded-lg border text-xs sm:text-base whitespace-nowrap {activeTab === 'danger' ? 'border-red-600 text-red-400' : 'border-gray-700 text-gray-300'}" onclick={() => (activeTab = 'danger')}>Danger Zone</button>
							</div>
						</div>
						<div class="p-3 sm:p-6 space-y-4 sm:space-y-6">
							{#if activeTab === 'members'}
								<div>
									<h4 class="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wide">Team Members</h4>
									<div class="space-y-2">
										{#each managed.group.members as member}
											{@const badge = getMemberBadge(member.isLeader, member.userId === data.user?.id)}
											<div class="flex items-center justify-between bg-theater-dark rounded-lg px-4 py-3 border border-gray-800">
												<div class="flex items-center gap-3">
													<span class="text-lg">{member.isLeader ? '👑' : '🎤'}</span>
													<span class="text-white font-semibold">{member.user.name}</span>
													<span class="text-xs px-2 py-1 rounded-full {badge.color}">{badge.text}</span>
												</div>
												{#if managed.isLeader && member.userId !== data.user?.id}
													<form method="POST" action="?/removeMember" use:enhance>
														<input type="hidden" name="groupId" value={managed.group.id} />
														<input type="hidden" name="userId" value={member.userId} />
														<button type="submit" class="text-red-400 hover:text-red-300 text-sm font-semibold transition">🗑️ Remove</button>
													</form>
												{/if}
											</div>
										{/each}
									</div>
									{#if managed.isLeader}
										<div class="mt-4">
											<p class="text-sm text-gray-400 mb-2">Invite Code</p>
											<div class="flex gap-2 items-center">
												<code class="flex-1 bg-theater-darker px-4 py-3 rounded-lg text-lg font-mono text-purple-300 font-bold tracking-wider border border-gray-700">{managed.group.inviteCode}</code>
												<button onclick={() => copyInviteCode(managed.group.inviteCode)} class="px-4 py-3 bg-theater-purple hover:bg-purple-600 text-white rounded-lg text-sm font-semibold transition">📋 Copy</button>
											</div>
										</div>
									{/if}
								</div>
							{/if}
							{#if activeTab === 'presentation'}
								{#if managed.isLeader}
									<div class="bg-theater-dark p-4 rounded-lg border border-gray-700 mb-4">
										<div class="flex justify-between items-center mb-3">
											<h5 class="text-sm font-semibold text-gray-400 uppercase tracking-wide">Presentation Identity</h5>
										</div>
										<form method="POST" action="?/updateGroup" use:enhance class="space-y-4">
											<input type="hidden" name="groupId" value={managed.group.id} />
											<div>
												<label for="edit-emoji-{managed.group.id}" class="text-gray-300 mb-2 block text-sm">Emoji (single emoji only)</label>
												<input 
													id="edit-emoji-{managed.group.id}"
													type="text" 
													name="emoji" 
													bind:value={editEmoji}
													maxlength="2"
													oninput={(e) => {
														const value = e.currentTarget.value;
														const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
														const segments = Array.from(segmenter.segment(value));
														if (segments.length > 1) {
															e.currentTarget.value = segments[0].segment;
															editEmoji = segments[0].segment;
														}
													}}
													placeholder="Type or pick emoji"
													class="w-full bg-theater-darker border border-gray-700 rounded-lg px-4 py-3 text-white text-2xl text-center placeholder:text-gray-500 placeholder:text-base focus:outline-none focus:border-theater-purple mb-3"
												/>
												<div class="text-xs text-gray-400 mb-2 text-center">Quick picks:</div>
												<div class="grid grid-cols-8 gap-2 p-3 bg-theater-darker border border-gray-700 rounded-lg">
													{#each emojiOptions as emoji}
														<button type="button" onclick={() => (editEmoji = emoji)} class="text-2xl p-2 rounded-lg transition hover:bg-theater-purple/20 {editEmoji === emoji ? 'bg-theater-purple ring-2 ring-theater-purple' : 'hover:scale-110'}">{emoji}</button>
													{/each}
												</div>
											</div>
											<div>
												<label for="edit-name-{managed.group.id}" class="text-gray-300 mb-2 block text-sm">Presentation Name</label>
												<input id="edit-name-{managed.group.id}" name="name" required bind:value={editName} class="w-full bg-theater-darker border border-gray-700 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:border-theater-purple" />
											</div>
											<div class="flex gap-2">
												<button type="submit" class="flex-1 py-2 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-semibold transition">💾 Save</button>
												<button type="button" onclick={() => { editEmoji = managed.group.emoji || '📊'; editName = managed.group.name; }} class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition">Reset</button>
											</div>
										</form>
									</div>
								{/if}
								<div class="border border-gray-700 rounded-lg p-4">
									<h5 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">Presentation Submission</h5>
									{#if (data.event as any).submissionsClosed}
										<div class="bg-yellow-900/30 border border-yellow-500/30 rounded-lg p-4">
											<p class="text-yellow-400 font-semibold">🔒 Submissions are closed for this event</p>
											{#if managed.group.status === 'submitted' && managed.group.submissionLink}
												<div class="mt-3 pt-3 border-t border-yellow-500/30">
													<p class="text-gray-400 text-sm mb-1">Your submitted link:</p>
													<a href={managed.group.submissionLink} target="_blank" class="text-blue-400 hover:text-blue-300 text-sm underline break-all">{managed.group.submissionLink}</a>
												</div>
											{/if}
										</div>
									{:else}
										{#if managed.group.status === 'submitted' && managed.group.submissionLink}
											<div class="bg-green-900/30 border border-green-500/30 rounded-lg p-4 mb-4">
												<p class="text-green-300 font-bold mb-2 text-sm uppercase tracking-wide">✅ Current Submission</p>
												<a href={managed.group.submissionLink} target="_blank" class="text-blue-400 hover:text-blue-300 text-sm underline break-all">{managed.group.submissionLink}</a>
												<p class="text-gray-400 text-xs mt-2">Submit again below to update.</p>
											</div>
										{/if}
										<form method="POST" action="?/submitPresentation" use:enhance class="space-y-3">
											<input type="hidden" name="groupId" value={managed.group.id} />
											<label for="submissionLink-{managed.group.id}" class="text-gray-300 text-sm mb-1 block font-semibold">{managed.group.status === 'submitted' ? 'Update Presentation Link (optional)' : 'Presentation Link (optional)'}</label>
											<input id="submissionLink-{managed.group.id}" name="submissionLink" type="url" placeholder="https://slides.google.com/..." value={managed.group.status === 'submitted' ? managed.group.submissionLink : ''} class="w-full bg-theater-dark border border-gray-700 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:border-theater-purple transition" />
											<button type="submit" class="w-full py-3 bg-theater-purple hover:bg-purple-600 text-white rounded-lg font-bold transition text-lg">{managed.group.status === 'submitted' ? '🔄 Update Presentation' : '🎯 Submit Presentation'}</button>
										</form>
									{/if}
								</div>
							{/if}
							{#if activeTab === 'danger' && managed.isLeader}
								<div class="border-t border-gray-700 pt-2"></div>
								<div>
									<h5 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">Danger Zone</h5>
									<form method="POST" action="?/deleteGroup" use:enhance>
										<input type="hidden" name="groupId" value={managed.group.id} />
										<button type="submit" class="w-full py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition" onclick={(e) => { if (!confirm('Delete this presentation? This removes all members and cannot be undone.')) e.preventDefault(); }}>🗑️ Delete Presentation</button>
									</form>
									<p class="text-xs text-gray-500 mt-2 text-center">This cannot be undone.</p>
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}
		{/if}
	</div>
</div>
