<script lang="ts">
	import { enhance } from "$app/forms";
	import { goto } from "$app/navigation";
	import { invalidateAll } from "$app/navigation";
	import PageContainer from "$lib/components/PageContainer.svelte";
	import PageHeader from "$lib/components/PageHeader.svelte";
	import { formatInTimezone, toDateTimeLocal, getTimezoneAbbr } from "$lib/utils/timezone";
	import { formatDistanceToNow } from "date-fns";
	import QRCode from "qrcode";
	import { onMount } from "svelte";

	let { data } = $props();
	let qrCodeUrl = $state("");
	let editingCategories = $state(false);
	let showEditModal = $state(false);

	const event = $derived(data.event);
	const submissionsOpen = $derived(!event.submissionsClosed);
	const joinUrl = $derived(
		`${typeof window !== "undefined" ? window.location.origin : ""}/night/${event.joinCode}`,
	);

	// Categories for reordering
	let categories = $state<any[]>([]);
	let draggedIndex = $state<number | null>(null);

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
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action: "reorderCategories",
				categories: categories.map((cat, index) => ({
					id: cat.id,
					order: index,
				})),
			}),
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
				dark: "#8b5cf6",
				light: "#0a0a0f",
			},
		});
	});

	function copyJoinCode() {
		navigator.clipboard.writeText(event.joinCode);
		alert("Join code copied to clipboard!");
	}

	function copyJoinUrl() {
		navigator.clipboard.writeText(joinUrl);
		alert("Join URL copied to clipboard!");
	}

	function getStatusBadge(status: string) {
		const badges = {
			setup: { emoji: "📝", text: "Setup", color: "bg-blue-900/30 text-blue-300 border-blue-700" },
			live: { emoji: "🔴", text: "Live", color: "bg-red-900/30 text-red-300 border-red-700" },
			voting: {
				emoji: "⭐",
				text: "Voting",
				color: "bg-yellow-900/30 text-yellow-300 border-yellow-700",
			},
			completed: {
				emoji: "✅",
				text: "Completed",
				color: "bg-green-900/30 text-green-300 border-green-700",
			},
		};
		return badges[status as keyof typeof badges] || badges.setup;
	}

	async function toggleSubmissions() {
		const response = await fetch(`/event/${event.id}/settings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action: "toggleSubmissions",
				submissionsClosed: submissionsOpen,
			}),
		});

		if (response.ok) {
			await invalidateAll();
		}
	}

	const statusBadge = $derived(getStatusBadge(event.status));
</script>

<PageContainer maxWidth="7xl">
	<PageHeader title={event.name} backLink="/dashboard">
		<span class="rounded-full border px-3 py-1 {statusBadge.color} text-sm font-semibold">
			{statusBadge.emoji}
			{statusBadge.text}
		</span>
	</PageHeader>

	<div class="grid gap-6 lg:grid-cols-3">
		<!-- Main Content -->
		<div class="space-y-6 lg:col-span-2">
			<!-- Event Details / Settings -->
			<div class="glass rounded-xl p-6">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-2xl font-semibold">Event Settings</h2>
					{#if data.isHost}
						<div class="flex gap-2">
							<button
								onclick={() => (showEditModal = true)}
								class="rounded-lg bg-gray-700 px-4 py-2 text-sm font-semibold transition-all duration-200 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-theater-darker"
							>
								✏️ Edit
							</button>
							<form method="POST" action="?/deleteEvent" use:enhance>
								<button
									type="submit"
									onclick={(e) => {
										if (
											!confirm(
												"Are you sure you want to delete this event? This will permanently delete all groups, submissions, votes, and other data. This cannot be undone.",
											)
										) {
											e.preventDefault();
										}
									}}
									class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold transition-all duration-200 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-theater-darker"
								>
									🗑️ Delete Event
								</button>
							</form>
						</div>
					{/if}
				</div>

				<div class="space-y-4">
					<div class="grid gap-4 md:grid-cols-2">
						<div>
							<p class="text-sm text-gray-400">Host</p>
							<p class="text-lg">{event.host.name}</p>
						</div>
						<div>
							<p class="text-sm text-gray-400">Submission Deadline</p>
							<p class="text-lg">
								{#if event.submissionDeadline}
									{formatInTimezone(event.submissionDeadline, event.timezone)}
									{getTimezoneAbbr(event.timezone)}
								{:else}
									No deadline
								{/if}
							</p>
						</div>
						<div>
							<p class="text-sm text-gray-400">Max Presentation Time</p>
							<p class="text-lg">
								{event.maxPresentationTime ? `${event.maxPresentationTime} minutes` : "Unlimited"}
							</p>
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
							<p class="text-lg">{submissionsOpen ? "✅ Open" : "🔒 Closed"}</p>
						</div>
					</div>

					{#if data.isHost}
						<div class="border-t border-gray-700 pt-4">
							<button
								onclick={toggleSubmissions}
								class="w-full rounded-lg px-6 py-3 font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker {submissionsOpen
									? 'border-2 border-red-700 bg-red-900/30 text-red-300 hover:bg-red-900/50 focus:ring-red-500'
									: 'border-2 border-green-700 bg-green-900/30 text-green-300 hover:bg-green-900/50 focus:ring-green-500'}"
							>
								{submissionsOpen ? "🔒 Close Submissions" : "🔓 Open Submissions"}
							</button>
						</div>
					{/if}
				</div>
			</div>

			<!-- Rating Categories -->
			<div class="glass rounded-xl p-6">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-2xl font-semibold">Rating Categories</h2>
					{#if data.isHost && !editingCategories}
						<button
							onclick={startEditingCategories}
							class="rounded-lg bg-gray-700 px-4 py-2 text-sm font-semibold transition-all duration-200 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-theater-darker"
						>
							↕️ Reorder
						</button>
					{/if}
				</div>

				{#if editingCategories}
					<div class="space-y-3">
						<p class="mb-3 text-sm text-gray-400">Drag and drop to reorder categories</p>
						{#each categories as category, index}
							<div
								role="button"
								tabindex="0"
								draggable="true"
								ondragstart={() => handleDragStart(index)}
								ondragover={(e) => handleDragOver(e, index)}
								ondragend={handleDragEnd}
								class="cursor-move rounded-lg border border-gray-700 bg-theater-darker p-4 transition-colors hover:border-theater-purple {draggedIndex ===
								index
									? 'opacity-50'
									: ''}"
							>
								<div class="flex items-center gap-3">
									<span class="text-gray-500">⋮⋮</span>
									<div class="flex-1">
										<h3 class="mb-1 text-lg font-semibold">{category.name}</h3>
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
								class="flex-1 rounded-lg bg-theater-purple px-6 py-3 font-semibold transition-all duration-200 hover:bg-purple-600 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:ring-offset-2 focus:ring-offset-theater-darker"
							>
								💾 Save Order
							</button>
							<button
								onclick={cancelCategoryEditing}
								class="rounded-lg bg-gray-700 px-6 py-3 font-semibold transition-all duration-200 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-theater-darker"
							>
								Cancel
							</button>
						</div>
					</div>
				{:else}
					<div class="space-y-3">
						{#each event.categories as category}
							<div class="rounded-lg border border-gray-700 bg-theater-darker p-4">
								<h3 class="mb-1 text-lg font-semibold">{category.name}</h3>
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
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-2xl font-semibold">Registered Groups ({event.groups.length})</h2>
					<span class="text-sm text-gray-400">
						{event.groups.filter((g) => g.status === "submitted").length} submitted
					</span>
				</div>
				{#if event.groups.length === 0}
					<p class="py-8 text-center text-gray-400">No groups have registered yet.</p>
				{:else}
					<div class="space-y-3">
						{#each event.groups as group}
							<div
								class="rounded-lg border border-gray-700 bg-theater-darker p-5 transition hover:border-gray-600"
							>
								<div class="mb-3 flex items-start justify-between">
									<div class="flex-1">
										<h3 class="mb-1 text-lg font-semibold">
											{group.emoji || "📊"}
											{group.name}
										</h3>
										<div class="flex items-center gap-3 text-sm">
											<span class="text-gray-400">
												👥 {group.members.length} member{group.members.length !== 1 ? "s" : ""}
											</span>
											{#if group.presentationType}
												<span class="text-gray-400">
													🎭 {group.presentationType}
												</span>
											{/if}
										</div>
									</div>
									<span
										class="rounded-full px-3 py-1.5 text-xs font-semibold {group.status ===
										'submitted'
											? 'border border-green-500/30 bg-green-900/30 text-green-300'
											: 'border border-gray-700 bg-gray-800 text-gray-400'}"
									>
										{group.status === "submitted" ? "✅ Submitted" : "⏳ Pending"}
									</span>
								</div>

								<!-- Member List -->
								<div class="mb-3">
									<p class="mb-2 text-xs uppercase tracking-wide text-gray-500">Team Members</p>
									<div class="flex flex-wrap gap-2">
										{#each group.members as member}
											<span
												class="rounded border border-gray-700 bg-theater-dark px-2 py-1 text-sm"
											>
												{#if member.isLeader}
													<span class="text-purple-400">👑</span>
												{/if}
												{member.user.name}
											</span>
										{/each}
									</div>
								</div>

								<!-- Submission Info -->
								{#if group.status === "submitted"}
									<div class="border-t border-gray-700 pt-3">
										{#if group.submissionLink}
											<div class="flex items-start gap-2">
												<span class="text-sm text-green-400">🔗</span>
												<a
													href={group.submissionLink}
													target="_blank"
													class="flex-1 break-all text-sm text-blue-400 underline hover:text-blue-300"
												>
													{group.submissionLink}
												</a>
											</div>
										{/if}
										{#if group.submittedAt}
											<p class="mt-2 text-xs text-gray-500">
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
				<h2 class="mb-4 text-xl font-semibold">Join Information</h2>

				<div class="space-y-4">
					<!-- Join Code -->
					<div>
						<p class="mb-2 text-sm text-gray-400">Event Code</p>
						<div class="flex gap-2">
							<code
								class="flex-1 rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 font-mono text-lg text-theater-purple"
							>
								{event.joinCode}
							</code>
							<button
								onclick={copyJoinCode}
								class="rounded-lg bg-gray-700 px-4 py-2 font-semibold transition-all duration-200 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-theater-darker"
								title="Copy code"
							>
								📋
							</button>
						</div>
					</div>

					<!-- Join URL -->
					<div>
						<p class="mb-2 text-sm text-gray-400">Join URL</p>
						<div class="flex gap-2">
							<input
								type="text"
								readonly
								value={joinUrl}
								class="flex-1 rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-sm text-gray-300"
							/>
							<button
								onclick={copyJoinUrl}
								class="rounded-lg bg-gray-700 px-4 py-2 font-semibold transition-all duration-200 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-theater-darker"
								title="Copy URL"
							>
								📋
							</button>
						</div>
					</div>

					<!-- QR Code -->
					{#if qrCodeUrl}
						<div class="text-center">
							<p class="mb-3 text-sm text-gray-400">Scan to Join</p>
							<img
								src={qrCodeUrl}
								alt="QR Code"
								class="mx-auto rounded-lg border-2 border-theater-purple"
							/>
						</div>
					{/if}
				</div>
			</div>

			<!-- Quick Stats -->
			<div class="glass rounded-xl p-6">
				<h2 class="mb-4 text-xl font-semibold">Stats</h2>
				<div class="space-y-3">
					<div class="flex justify-between">
						<span class="text-gray-400">Total Groups</span>
						<span class="font-semibold">{event.groups.length}</span>
					</div>
					<div class="flex justify-between pl-4 text-sm">
						<span class="text-gray-500">✅ Submitted</span>
						<span class="font-semibold text-green-400"
							>{event.groups.filter((g) => g.status === "submitted").length}</span
						>
					</div>
					<div class="flex justify-between pl-4 text-sm">
						<span class="text-gray-500">⏳ Pending</span>
						<span class="font-semibold text-gray-400"
							>{event.groups.filter((g) => g.status !== "submitted").length}</span
						>
					</div>
					<div class="mt-3 border-t border-gray-700 pt-3"></div>
					<div class="flex justify-between">
						<span class="text-gray-400">Total Presenters</span>
						<span class="font-semibold"
							>{event.groups.reduce((sum, g) => sum + g.members.length, 0)}</span
						>
					</div>
					<div class="flex justify-between">
						<span class="text-gray-400">Judges</span>
						<span class="font-semibold">{event.judges.length}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-gray-400">Categories</span>
						<span class="font-semibold">{event.categories.length}</span>
					</div>
					<div class="mt-3 border-t border-gray-700 pt-3"></div>
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
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) showEditModal = false;
		}}
	>
		<div
			class="glass max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-gray-800 p-6"
		>
			<h2 class="mb-6 text-2xl font-semibold">Edit Event Settings</h2>

			<form
				method="POST"
				action="?/updateSettings"
				use:enhance={() => {
					return async ({ result }) => {
						if (result.type === "success") {
							await invalidateAll();
							showEditModal = false;
						} else if (result.type === "failure") {
							alert(result.data?.error || "Failed to update settings");
						}
					};
				}}
			>
				<div class="space-y-4">
					<div>
						<label for="modal-name" class="mb-2 block text-sm font-medium text-gray-300"
							>Event Name</label
						>
						<input
							type="text"
							id="modal-name"
							name="name"
							defaultValue={event.name}
							required
							class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
						/>
					</div>

					<div>
						<label for="modal-theme" class="mb-2 block text-sm font-medium text-gray-300"
							>Theme (optional)</label
						>
						<input
							type="text"
							id="modal-theme"
							name="theme"
							defaultValue={event.theme ?? ""}
							class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
						/>
					</div>

					<div>
						<label for="modal-description" class="mb-2 block text-sm font-medium text-gray-300"
							>Description (optional)</label
						>
						<textarea
							id="modal-description"
							name="description"
							defaultValue={event.description ?? ""}
							rows="3"
							class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
						></textarea>
					</div>

					<div class="grid gap-4 md:grid-cols-2">
						<div>
							<label for="modal-deadline" class="mb-2 block text-sm font-medium text-gray-300"
								>Submission Deadline (in {getTimezoneAbbr(event.timezone)})</label
							>
							<input
								type="datetime-local"
								id="modal-deadline"
								name="submissionDeadline"
								defaultValue={event.submissionDeadline
									? toDateTimeLocal(event.submissionDeadline, event.timezone)
									: ""}
								class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white [color-scheme:dark] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
							/>
						</div>

						<div>
							<label for="modal-time" class="mb-2 block text-sm font-medium text-gray-300"
								>Max Time (minutes, optional)</label
							>
							<input
								type="number"
								id="modal-time"
								name="maxPresentationTime"
								defaultValue={event.maxPresentationTime ?? ""}
								min="1"
								class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
							/>
						</div>
					</div>

					<div>
						<label for="modal-order" class="mb-2 block text-sm font-medium text-gray-300"
							>Presentation Order</label
						>
						<select
							id="modal-order"
							name="orderMode"
							value={event.orderMode}
							class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-2 text-white focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
						>
							<option value="random">Random</option>
							<option value="alphabetical">Alphabetical</option>
						</select>
					</div>

					<div class="flex gap-3 pt-4">
						<button
							type="submit"
							class="flex-1 rounded-lg bg-theater-purple px-6 py-3 font-semibold transition-all duration-200 hover:bg-purple-600 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:ring-offset-2 focus:ring-offset-theater-darker"
						>
							💾 Save Changes
						</button>
						<button
							type="button"
							onclick={() => (showEditModal = false)}
							class="rounded-lg bg-gray-700 px-6 py-3 font-semibold transition-all duration-200 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-theater-darker"
						>
							Cancel
						</button>
					</div>
				</div>
			</form>
		</div>
	</div>
{/if}
