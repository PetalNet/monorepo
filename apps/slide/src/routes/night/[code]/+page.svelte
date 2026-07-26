<script lang="ts">
	import { enhance, applyAction } from "$app/forms";
	import { goto, invalidateAll } from "$app/navigation";
	import PageContainer from "$lib/components/PageContainer.svelte";
	import {
		formatInTimezone,
		toDateTimeLocal,
		getTimezoneAbbr,
		COMMON_TIMEZONES,
	} from "$lib/utils/timezone";
	import { format } from "date-fns";
	import QRCode from "qrcode";
	import Sortable from "sortablejs";
	import { onMount } from "svelte";

	let { data, form } = $props();

	// ✨ Simplified UI state
	let uiMode = $state<"none" | "create" | "join">("none");
	let managedGroupId = $state<string | null>(null);
	let activeTab = $state<"members" | "presentation" | "danger">("members");
	let showHostSettings = $state(false);
	let qrCodeUrl = $state("");
	let showCreateModal = $state(false);
	let showJoinModal = $state(false);
	let showCategoriesModal = $state(false);
	let hostPresentationListElement = $state<HTMLElement | null>(null);
	let editingCategories = $state<
		Array<{ id?: string; name: string; description: string; order: number }>
	>([]);

	// Emoji picker state for create/edit
	let selectedEmoji = $state("📊");
	let editEmoji = $state("📊");
	let editName = $state("");

	const emojiOptions = [
		"📊",
		"🎤",
		"🎬",
		"🎨",
		"🎯",
		"🚀",
		"💡",
		"⭐",
		"🔥",
		"✨",
		"🎪",
		"🎭",
		"🎸",
		"🎮",
		"💻",
		"📱",
	];

	const joinUrl = $derived(
		`${typeof window !== "undefined" ? window.location.origin : ""}/night/${data.event.joinCode}`,
	);

	onMount(async () => {
		if (data.isHost) {
			qrCodeUrl = await QRCode.toDataURL(joinUrl, {
				width: 300,
				margin: 2,
				color: {
					dark: "#8b5cf6",
					light: "#0a0a0f",
				},
			});

			// Setup sortable for host presentations list when in host mode
			// Use setTimeout to ensure the element is rendered
			setTimeout(() => {
				if (hostPresentationListElement && data.event.groups.length > 0) {
					Sortable.create(hostPresentationListElement, {
						animation: 150,
						handle: ".drag-handle-host",
						ghostClass: "opacity-50",
						onEnd: async (evt) => {
							if (
								evt.oldIndex !== evt.newIndex &&
								evt.oldIndex !== undefined &&
								evt.newIndex !== undefined
							) {
								await handleReorder(evt.oldIndex, evt.newIndex);
							}
						},
					});
				}
			}, 100);
		}
	});

	function copyJoinCode() {
		navigator.clipboard.writeText(data.event.joinCode);
		alert("Join code copied!");
	}

	function copyJoinUrl() {
		navigator.clipboard.writeText(joinUrl);
		alert("Join URL copied!");
	}

	function getGroupStatus(group: any) {
		if (group.status === "submitted")
			return { text: "✅ Submitted", color: "bg-green-900/30 border-green-500/30 text-green-300" };
		if ((data.event as any).submissionsClosed || data.deadlinePassed)
			return { text: "🔒 Closed", color: "bg-yellow-900/30 border-yellow-500/30 text-yellow-300" };
		return { text: "⏳ Pending", color: "bg-gray-800 border-gray-700 text-gray-400" };
	}

	function getMemberBadge(isLeader: boolean, isYou: boolean) {
		if (isLeader && isYou)
			return {
				text: "👑 You (Leader)",
				color: "bg-gradient-to-r from-yellow-500 to-purple-600 text-white font-bold",
			};
		if (isLeader) return { text: "⭐ Leader", color: "bg-theater-purple text-white" };
		if (isYou) return { text: "🎤 You", color: "bg-blue-600 text-white font-semibold" };
		return { text: "👤 Member", color: "bg-gray-700 text-gray-300" };
	}

	function copyInviteCode(code: string) {
		navigator.clipboard.writeText(code);
		alert(`Invite code copied: ${code}`);
	}

	function openManage(group: any) {
		managedGroupId = group.id;
		activeTab = "members";
		editEmoji = group.emoji || "📊";
		editName = group.name || "";
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
		editingCategories =
			data.event.categories?.length > 0
				? data.event.categories.map((cat: any) => ({
						id: cat.id,
						name: cat.name,
						description: cat.description || "",
						order: cat.order,
					}))
				: [{ name: "", description: "", order: 0 }];
		showCategoriesModal = true;
	}

	function closeCategoriesModal() {
		showCategoriesModal = false;
	}

	function addCategory() {
		editingCategories = [
			...editingCategories,
			{
				name: "",
				description: "",
				order: editingCategories.length,
			},
		];
	}

	function removeCategory(index: number) {
		editingCategories = editingCategories.filter((_, i) => i !== index);
		// Update order
		editingCategories.forEach((cat, idx) => (cat.order = idx));
	}

	function moveCategoryUp(index: number) {
		if (index > 0) {
			[editingCategories[index], editingCategories[index - 1]] = [
				editingCategories[index - 1],
				editingCategories[index],
			];
			editingCategories.forEach((cat, idx) => (cat.order = idx));
			editingCategories = [...editingCategories];
		}
	}

	function moveCategoryDown(index: number) {
		if (index < editingCategories.length - 1) {
			[editingCategories[index], editingCategories[index + 1]] = [
				editingCategories[index + 1],
				editingCategories[index],
			];
			editingCategories.forEach((cat, idx) => (cat.order = idx));
			editingCategories = [...editingCategories];
		}
	}

	async function saveCategories() {
		const formData = new FormData();
		formData.append("categories", JSON.stringify(editingCategories));

		const response = await fetch(`/night/${data.event.joinCode}?/updateCategories`, {
			method: "POST",
			body: formData,
		});

		if (response.ok) {
			window.location.reload();
		}
	}

	async function handleReorder(oldIndex: number, newIndex: number) {
		const sortedGroups = [...data.event.groups].toSorted(
			(a: any, b: any) => (a.presentationOrder || 999) - (b.presentationOrder || 999),
		);
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
		formData.append("orderedGroupIds", JSON.stringify(orderedGroupIds));

		fetch(`/night/${data.event.joinCode}?/reorderPresentations`, {
			method: "POST",
			body: formData,
		});
	}
</script>

<PageContainer maxWidth="6xl">
	<!-- === JOIN EVENT CALL-TO-ACTION (For non-participants) === -->
	{#if !data.user}
		<div
			class="rounded-xl border-2 border-purple-700 bg-gradient-to-r from-purple-900/40 via-theater-dark to-purple-900/40 p-6 shadow-lg ring-2 ring-purple-700/30 md:p-8"
		>
			<div class="text-center">
				<h2 class="mb-3 text-2xl font-bold sm:text-3xl">🎉 You're Invited to Join This Event!</h2>
				<p class="mb-6 text-lg text-gray-300">
					Sign up or log in to create a presentation and participate
				</p>
				<div class="flex flex-wrap justify-center gap-4">
					<a
						href="/auth/signup?redirectTo=/night/{data.event.joinCode}"
						class="rounded-lg bg-theater-purple px-8 py-4 text-lg font-bold text-white shadow-lg transition hover:bg-purple-600"
					>
						✨ Sign Up to Join
					</a>
					<a
						href="/auth/login?redirectTo=/night/{data.event.joinCode}"
						class="rounded-lg bg-gray-700 px-8 py-4 text-lg font-bold text-white shadow-lg transition hover:bg-gray-600"
					>
						🔑 Log In
					</a>
				</div>
			</div>
		</div>
	{:else if data.userGroups.length === 0}
		<div
			class="rounded-xl border-2 border-purple-700 bg-gradient-to-r from-purple-900/40 via-theater-dark to-purple-900/40 p-6 shadow-lg ring-2 ring-purple-700/30 md:p-8"
		>
			<div class="text-center">
				<h2 class="mb-3 text-2xl font-bold sm:text-3xl">👋 Ready to Join This Event?</h2>
				<p class="mb-6 text-lg text-gray-300">
					Create your own presentation or join an existing team to participate
				</p>
				<div class="flex flex-wrap justify-center gap-4">
					<button
						onclick={openCreateModal}
						class="rounded-lg bg-theater-purple px-8 py-4 text-lg font-bold text-white shadow-lg transition hover:bg-purple-600"
					>
						✨ Create Presentation
					</button>
					<button
						onclick={openJoinModal}
						class="rounded-lg bg-gray-700 px-8 py-4 text-lg font-bold text-white shadow-lg transition hover:bg-gray-600"
					>
						🤝 Join a Team
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- === LIVE STATUS BANNER === -->
	{#if data.event.currentPresentationId || data.event.status === "completed"}
		<div
			class="rounded-xl border-2 bg-gradient-to-r from-red-900/40 via-theater-dark to-red-900/40 p-4 shadow-lg md:p-6 {data
				.event.status === 'completed'
				? 'border-green-700'
				: 'border-red-700'} ring-2 {data.event.status === 'completed'
				? 'ring-green-700/30'
				: 'ring-red-700/30'}"
		>
			<div class="flex flex-col items-center justify-between gap-4 md:flex-row">
				<div class="flex items-center gap-3">
					{#if data.event.status === "completed"}
						<div class="h-3 w-3 rounded-full bg-green-500"></div>
						<div>
							<h3 class="text-xl font-bold text-white">🏆 Event Completed</h3>
							<p class="text-sm text-gray-300">View the final results</p>
						</div>
					{:else if data.event.currentPresentationId}
						<div class="h-3 w-3 animate-pulse rounded-full bg-red-500"></div>
						<div>
							<h3 class="text-xl font-bold text-white">🎬 Presentations In Progress</h3>
							<p class="text-sm text-gray-300">A presentation is currently being shown</p>
						</div>
					{/if}
				</div>
				<a
					href="/night/{data.event.joinCode}/live"
					class="flex items-center gap-2 whitespace-nowrap rounded-lg bg-red-600 px-6 py-3 font-bold text-white shadow-lg transition-all hover:bg-red-700"
				>
					<span class="h-2 w-2 animate-pulse rounded-full bg-white"></span>
					{data.event.status === "completed" ? "View Results" : "Join Live Event"}
				</a>
			</div>
		</div>
	{/if}

	<!-- === 1. EVENT OVERVIEW (Always Visible) === -->
	<div class="glass rounded-xl border border-gray-800 p-4 shadow-lg md:p-8">
		<div class="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-start sm:gap-4">
			<div class="min-w-0 flex-1">
				<div class="mb-1 flex flex-wrap items-center gap-2">
					<h1 class="break-words text-2xl font-bold sm:text-3xl md:text-4xl">{data.event.name}</h1>
					{#if data.isHost}
						<span
							class="whitespace-nowrap rounded-full border border-purple-700 bg-purple-900/50 px-2 py-1 text-xs text-purple-300 sm:px-3 sm:text-sm"
							>👑 Host</span
						>
					{/if}
				</div>
				<p class="text-sm text-gray-400 sm:text-base">Hosted by {data.event.host.name}</p>
			</div>
			<div class="flex gap-2">
				<a
					href="/dashboard"
					class="self-start whitespace-nowrap rounded-lg bg-theater-purple px-3 py-2 text-sm text-white transition hover:bg-purple-600 sm:px-4 sm:py-2 sm:text-base"
					>← Back</a
				>
			</div>
		</div>
		{#if data.event.theme}
			<p class="mb-2 text-sm text-gray-300 sm:text-base">
				<span class="text-gray-400">Theme:</span>
				{data.event.theme}
			</p>
		{/if}
		{#if data.event.description}
			<p class="mb-4 text-sm text-gray-400 sm:mb-6 sm:text-base">{data.event.description}</p>
		{/if}
		<div class="grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-4">
			<div class="rounded-lg bg-theater-darker p-3 sm:p-4">
				<p class="mb-1 text-xs text-gray-400 sm:text-sm">Submissions</p>
				<p class="break-words text-lg font-bold sm:text-xl">
					{#if (data.event as any).submissionsClosed}
						🔒 Closed
					{:else if data.deadlinePassed}
						⏰ Deadline Passed
					{:else}
						✅ Open
					{/if}
				</p>
			</div>
			<div class="rounded-lg bg-theater-darker p-3 sm:p-4">
				<p class="mb-1 text-xs text-gray-400 sm:text-sm">Deadline</p>
				<p
					class="break-words text-sm font-semibold sm:text-lg"
					class:text-red-400={data.deadlinePassed}
				>
					{#if data.event.submissionDeadline}
						{formatInTimezone(data.event.submissionDeadline, data.event.timezone, {
							month: "short",
							day: "numeric",
							hour: "numeric",
							minute: "2-digit",
						})}
						{getTimezoneAbbr(data.event.timezone)}
						{#if data.deadlinePassed}
							<span class="mt-1 block text-xs text-red-400">(Passed)</span>
						{/if}
					{:else}
						No deadline
					{/if}
				</p>
			</div>
			<div class="rounded-lg bg-theater-darker p-3 sm:p-4">
				<p class="mb-1 text-xs text-gray-400 sm:text-sm">Max Time</p>
				<p class="text-lg font-bold sm:text-xl">
					{data.event.maxPresentationTime ? `${data.event.maxPresentationTime} min` : "Unlimited"}
				</p>
			</div>
			<div class="rounded-lg bg-theater-darker p-3 sm:p-4">
				<p class="mb-1 text-xs text-gray-400 sm:text-sm">Presentations</p>
				<p class="text-lg font-bold sm:text-xl">{data.event._count?.groups || 0}</p>
			</div>
		</div>
	</div>

	<!-- === 2. HOST MANAGEMENT (Host Only, Collapsible) === -->
	{#if data.isHost}
		<details class="glass rounded-xl border border-purple-700 p-4 shadow-lg md:p-8">
			<summary
				class="flex cursor-pointer items-center gap-2 text-xl font-bold transition hover:text-purple-300 sm:text-2xl"
			>
				⚙️ Event Management
				<span class="rounded-full bg-purple-900/30 px-2 py-0.5 text-xs text-purple-300"
					>Host Only</span
				>
			</summary>
			<div class="mt-6 space-y-6">
				<!-- QR Code & Join Info -->
				<div class="rounded-lg border border-gray-700 bg-theater-darker p-4">
					<h3 class="mb-4 text-lg font-semibold">Share Event</h3>
					<div class="flex flex-col gap-4 md:flex-row">
						{#if qrCodeUrl}
							<div class="flex flex-col items-center">
								<img
									src={qrCodeUrl}
									alt="Event QR Code"
									class="h-48 w-48 rounded-lg object-contain"
								/>
								<p class="mt-2 text-xs text-gray-400">Scan to join event</p>
							</div>
						{/if}
						<div class="flex-1 space-y-3">
							<div>
								<label class="mb-1 block text-xs text-gray-400">
									Join Code
									<div class="mt-1 flex gap-2">
										<code
											class="flex-1 rounded border border-gray-700 bg-theater-dark px-4 py-3 text-center font-mono text-lg font-bold text-purple-300"
											>{data.event.joinCode}</code
										>
										<button
											onclick={copyJoinCode}
											class="rounded bg-theater-purple px-4 py-3 font-semibold text-white transition hover:bg-purple-600"
											>📋 Copy</button
										>
									</div>
								</label>
							</div>
							<div>
								<label class="mb-1 block text-xs text-gray-400">
									Join URL
									<div class="mt-1 flex gap-2">
										<input
											readonly
											value={joinUrl}
											class="flex-1 rounded border border-gray-700 bg-theater-dark px-4 py-3 font-mono text-sm text-gray-300"
										/>
										<button
											onclick={copyJoinUrl}
											class="rounded bg-theater-purple px-4 py-3 font-semibold text-white transition hover:bg-purple-600"
											>📋 Copy</button
										>
									</div>
								</label>
							</div>
							<div class="pt-3">
								<a
									href="/event/{data.event.id}/live"
									class="block w-full rounded-lg bg-red-600 py-3 text-center font-bold text-white transition hover:bg-red-700"
								>
									🔴 Go Live
								</a>
							</div>
						</div>
					</div>
				</div>

				<div class="grid gap-6 md:grid-cols-2">
					<!-- Edit Event Settings -->
					<form
						method="POST"
						action="?/updateEvent"
						use:enhance={() => {
							return async ({ result }) => {
								if (result.type === "success") {
									await invalidateAll();
								} else if (result.type === "failure") {
									alert(result.data?.error || "Failed to update settings");
								}
							};
						}}
						class="space-y-4 rounded-lg border border-gray-700 bg-theater-darker p-4"
					>
						<h3 class="mb-2 text-lg font-semibold">Event Settings</h3>
						<label class="block">
							<span class="mb-1 block text-sm text-gray-300">Event Name</span>
							<input
								name="name"
								type="text"
								required
								defaultValue={data.event.name}
								class="w-full rounded-lg border border-gray-700 bg-theater-dark px-3 py-2 text-white focus:border-theater-purple focus:outline-none"
							/>
						</label>
						<label class="block">
							<span class="mb-1 block text-sm text-gray-300">Theme</span>
							<input
								name="theme"
								type="text"
								defaultValue={data.event.theme || ""}
								class="w-full rounded-lg border border-gray-700 bg-theater-dark px-3 py-2 text-white focus:border-theater-purple focus:outline-none"
							/>
						</label>
						<label class="block">
							<span class="mb-1 block text-sm text-gray-300">Description</span>
							<textarea
								name="description"
								rows="3"
								class="w-full rounded-lg border border-gray-700 bg-theater-dark px-3 py-2 text-white focus:border-theater-purple focus:outline-none"
								>{data.event.description || ""}</textarea
							>
						</label>
						<label class="block">
							<span class="mb-1 block text-sm text-gray-300">Event Timezone</span>
							<select
								name="timezone"
								value={data.event.timezone || "America/New_York"}
								class="w-full rounded-lg border border-gray-700 bg-theater-dark px-3 py-2 text-white focus:border-theater-purple focus:outline-none"
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
							<p class="mt-1 text-xs text-gray-400">All times will be shown in this timezone</p>
						</label>
						<label class="block">
							<span class="mb-1 block text-sm text-gray-300"
								>Submission Deadline (in {getTimezoneAbbr(data.event.timezone)})</span
							>
							<input
								name="submissionDeadline"
								type="datetime-local"
								defaultValue={data.event.submissionDeadline
									? toDateTimeLocal(data.event.submissionDeadline, data.event.timezone)
									: ""}
								class="w-full rounded-lg border border-gray-700 bg-theater-dark px-3 py-2 text-white [color-scheme:dark] focus:border-theater-purple focus:outline-none"
							/>
						</label>
						<label class="block">
							<span class="mb-1 block text-sm text-gray-300">Max Presentation Time (minutes)</span>
							<input
								name="maxPresentationTime"
								type="number"
								min="0"
								defaultValue={data.event.maxPresentationTime || ""}
								class="w-full rounded-lg border border-gray-700 bg-theater-dark px-3 py-2 text-white focus:border-theater-purple focus:outline-none"
							/>
						</label>
						<div class="flex items-center gap-3">
							<input
								name="submissionsClosed"
								type="checkbox"
								id="submissionsClosed"
								defaultChecked={(data.event as any).submissionsClosed}
								class="h-4 w-4 rounded border-gray-700 bg-theater-dark text-theater-purple focus:ring-theater-purple"
							/>
							<label for="submissionsClosed" class="text-sm text-gray-300"
								>Close submissions (prevent new presentations)</label
							>
						</div>
						<button
							type="submit"
							class="w-full rounded-lg bg-theater-purple py-2 font-semibold text-white transition hover:bg-purple-600"
						>
							💾 Save Settings
						</button>
					</form>

					<!-- Manage All Presentations -->
					<div class="rounded-lg border border-gray-700 bg-theater-darker p-4">
						<div class="mb-3 flex items-center justify-between">
							<h3 class="text-lg font-semibold">🎯 Presentation Order</h3>
							<span class="text-sm text-gray-400">{data.event.groups.length} total</span>
						</div>
						<p class="mb-3 text-xs text-gray-400">
							Drag presentations to reorder them for the live event.
						</p>
						<div bind:this={hostPresentationListElement} class="max-h-96 space-y-2 overflow-y-auto">
							{#if data.event.groups.length === 0}
								<p class="py-8 text-center text-sm text-gray-400">No presentations yet</p>
							{:else}
								{#each [...data.event.groups].sort((a, b) => (a.presentationOrder || 999) - (b.presentationOrder || 999)) as group, idx}
									<div
										class="flex cursor-move items-center gap-2 rounded-lg border border-gray-800 bg-theater-dark p-3 transition hover:border-theater-purple/50"
										data-id={group.id}
									>
										<button
											class="drag-handle-host cursor-move px-1 text-gray-400 transition hover:text-purple-300"
											title="Drag to reorder"
										>
											<span class="text-lg">⋮⋮</span>
										</button>
										<span class="w-8 font-mono text-sm text-gray-400">#{idx + 1}</span>
										<span class="flex-shrink-0 text-xl">{group.emoji || "📊"}</span>
										<div class="min-w-0 flex-1">
											<p class="truncate font-semibold text-white">{group.name}</p>
											<div class="flex items-center gap-2 text-xs text-gray-400">
												<span>👥 {group.members?.length || 0}</span>
												<span class="rounded-full px-2 py-0.5 {getGroupStatus(group).color}"
													>{getGroupStatus(group).text}</span
												>
											</div>
										</div>
									</div>
								{/each}
							{/if}
						</div>
					</div>
				</div>

				<!-- Advanced Management Options -->
				<div class="mt-6 grid gap-6 md:grid-cols-2">
					<!-- Rating Categories -->
					<div class="rounded-lg border border-gray-700 bg-theater-darker p-4">
						<h3 class="mb-3 text-lg font-semibold">📊 Rating Categories</h3>
						<div class="mb-4 max-h-60 space-y-2 overflow-y-auto">
							{#if data.event.categories && data.event.categories.length > 0}
								{#each data.event.categories.sort((a: any, b: any) => a.order - b.order) as category}
									<div
										class="flex items-center gap-2 rounded-lg border border-gray-800 bg-theater-dark p-2"
									>
										<span class="text-sm text-gray-400">#{category.order + 1}</span>
										<div class="min-w-0 flex-1">
											<p class="truncate text-sm font-semibold text-white">{category.name}</p>
											{#if category.description}
												<p class="truncate text-xs text-gray-400">{category.description}</p>
											{/if}
										</div>
									</div>
								{/each}
							{:else}
								<p class="py-4 text-center text-sm text-gray-400">No categories defined</p>
							{/if}
						</div>
						<button
							onclick={openCategoriesModal}
							class="w-full rounded-lg bg-gray-700 py-2 text-sm font-semibold text-white transition hover:bg-gray-600"
						>
							⚙️ Manage Categories
						</button>
					</div>

					<!-- Participant Management -->
					<div class="rounded-lg border border-gray-700 bg-theater-darker p-4 md:col-span-2">
						<h3 class="mb-3 text-lg font-semibold">� Participant Management</h3>
						{#if data.event.groups.length > 0}
							{@const participantMap = new Map()}
							{#each data.event.groups as group}
								{#each group.members || [] as member}
									{@const existing = participantMap.get(member.user.email)}
									{#if existing}
										{@const _ = existing.groups.push({
											id: group.id,
											name: group.name,
											emoji: group.emoji,
											isLeader: member.isLeader,
										})}
									{:else}
										{@const _ = participantMap.set(member.user.email, {
											userId: member.user.id,
											name: member.user.name,
											email: member.user.email,
											groups: [
												{
													id: group.id,
													name: group.name,
													emoji: group.emoji,
													isLeader: member.isLeader,
												},
											],
										})}
									{/if}
								{/each}
							{/each}
							{@const participants = Array.from(participantMap.values()).sort((a, b) =>
								a.name.localeCompare(b.name),
							)}

							<div class="mb-4 grid grid-cols-2 gap-4">
								<div class="glass rounded-lg border border-gray-800 p-3">
									<div class="text-sm text-gray-400">Total Participants</div>
									<div class="text-2xl font-bold text-white">{participants.length}</div>
								</div>
								<div class="glass rounded-lg border border-gray-800 p-3">
									<div class="text-sm text-gray-400">Total Presentations</div>
									<div class="text-2xl font-bold text-white">{data.event.groups.length}</div>
								</div>
							</div>

							<div class="max-h-96 space-y-2 overflow-y-auto">
								{#each participants as participant}
									<div class="glass rounded-lg border border-gray-800 p-3">
										<div class="mb-2 flex items-start justify-between gap-3">
											<div class="min-w-0 flex-1">
												<div class="mb-1 flex items-center gap-2">
													<span class="text-lg">👤</span>
													<span class="truncate font-semibold text-white">{participant.name}</span>
												</div>
												<span class="block truncate text-xs text-gray-400">{participant.email}</span
												>
											</div>
											<form method="POST" action="?/removeParticipant" use:enhance>
												<input type="hidden" name="userId" value={participant.userId} />
												<button
													type="submit"
													class="rounded-lg bg-red-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-700"
													onclick={(e) => {
														if (
															!confirm(
																`Remove ${participant.name} from all presentations in this event?`,
															)
														)
															e.preventDefault();
													}}
												>
													🗑️ Remove
												</button>
											</form>
										</div>
										<div class="flex flex-wrap gap-1">
											{#each participant.groups as group}
												<span
													class="inline-flex items-center gap-1 rounded-full border border-purple-700/30 bg-purple-900/30 px-2 py-1 text-xs"
												>
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
							<p class="py-8 text-center text-sm text-gray-400">No participants yet</p>
						{/if}
					</div>
				</div>
			</div>
		</details>
	{/if}

	<!-- === 3. EVENT PRESENTATIONS (Combined - Your presentations first, then all others) === -->
	<div class="glass rounded-xl border border-gray-800 p-4 shadow-lg md:p-8">
		<div class="mb-6 flex items-center justify-between">
			<h2 class="text-xl font-bold sm:text-2xl">📊 Event Presentations</h2>
			{#if data.user && data.userGroups.length > 0}
				<div class="flex gap-2">
					<button
						onclick={openCreateModal}
						disabled={(data.event as any).submissionsClosed || data.deadlinePassed}
						class="whitespace-nowrap rounded-lg bg-theater-purple px-3 py-2 text-sm font-semibold text-white transition hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-50 sm:px-4 sm:text-base"
						title={(data.event as any).submissionsClosed || data.deadlinePassed
							? "Submissions are closed"
							: ""}
					>
						✨ Create
					</button>
					<button
						onclick={openJoinModal}
						disabled={(data.event as any).submissionsClosed || data.deadlinePassed}
						class="whitespace-nowrap rounded-lg bg-gray-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50 sm:px-4 sm:text-base"
						title={(data.event as any).submissionsClosed || data.deadlinePassed
							? "Submissions are closed"
							: ""}
					>
						🤝 Join
					</button>
				</div>
			{/if}
		</div>

		{#if data.deadlinePassed && !data.isHost}
			<div class="mb-6 rounded-lg border border-red-700/50 bg-red-900/20 p-4">
				<div class="flex items-start gap-3">
					<span class="text-2xl">⏰</span>
					<div>
						<p class="mb-1 font-semibold text-red-300">Submission Deadline Has Passed</p>
						<p class="text-sm text-red-200">
							New presentations can no longer be created or joined for this event.
						</p>
					</div>
				</div>
			</div>
		{/if}

		{#if data.event.groups.length === 0}
			<div class="py-12 text-center">
				<p class="mb-2 text-lg text-gray-400">No presentations yet</p>
				<p class="text-sm text-gray-500">Be the first to create a presentation for this event!</p>
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

			<div class="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
				{#each sortedGroups as group}
					{@const status = getGroupStatus(group)}
					{@const isUserInGroup = data.user ? userGroupIds.has(group.id) : false}
					{@const userMembership = data.userGroups.find((ug: any) => ug.group.id === group.id)}

					{#if isUserInGroup}
						<!-- User's Presentation - Gradient background with manage button -->
						<div
							class="rounded-xl border-2 border-theater-purple bg-gradient-to-br from-purple-900/40 via-theater-dark to-theater-dark p-4 shadow-lg ring-2 ring-theater-purple/30 transition hover:ring-theater-purple/50 sm:p-5"
						>
							<div class="mb-3 flex items-start gap-3">
								<span class="flex-shrink-0 text-3xl sm:text-4xl">{group.emoji || "📊"}</span>
								<div class="min-w-0 flex-1">
									<h3
										class="mb-2 break-words text-lg font-bold leading-tight text-white sm:text-xl"
									>
										{group.name}
									</h3>
									<div class="mb-2 flex flex-wrap items-center gap-2">
										<span class="rounded-full px-2 py-1 text-xs {status.color}">{status.text}</span>
										{#if userMembership?.isLeader}
											<span
												class="rounded-full border border-yellow-700 bg-yellow-900/50 px-2 py-1 text-xs text-yellow-300"
												>👑 Leader</span
											>
										{/if}
										<span
											class="rounded-full border border-purple-700 bg-purple-900/50 px-2 py-1 text-xs text-purple-300"
											>✨ You're in this</span
										>
									</div>
								</div>
							</div>
							<div class="mb-3 border-t border-purple-700/30 pt-3">
								<p class="mb-2 text-sm text-gray-400">
									👥 Team Members ({group.members?.length || 0})
								</p>
								<div class="max-h-24 space-y-1 overflow-y-auto">
									{#each group.members as member}
										<div class="flex items-center gap-2 text-sm">
											<span>{member.isLeader ? "👑" : "🎤"}</span>
											<span class="flex-1 truncate text-white">{member.user.name}</span>
											{#if member.userId === data.user?.id}
												<span class="text-xs text-purple-400">(You)</span>
											{/if}
										</div>
									{/each}
								</div>
							</div>
							<button
								onclick={() => openManage(group)}
								class="w-full rounded-lg bg-theater-purple py-2.5 font-bold text-white transition hover:bg-purple-600"
							>
								⚙️ Manage Presentation
							</button>
						</div>
					{:else}
						<!-- Other Presentations - Simple display only -->
						<div
							class="rounded-xl border border-gray-800 bg-theater-darker p-4 opacity-90 shadow-lg sm:p-5"
						>
							<div class="mb-3 flex items-start gap-3">
								<span class="flex-shrink-0 text-3xl sm:text-4xl">{group.emoji || "📊"}</span>
								<div class="min-w-0 flex-1">
									<h3
										class="mb-2 break-words text-lg font-bold leading-tight text-white sm:text-xl"
									>
										{group.name}
									</h3>
									<span class="inline-block rounded-full px-2 py-1 text-xs {status.color}"
										>{status.text}</span
									>
								</div>
							</div>
							<div class="border-t border-gray-700 pt-3">
								<p class="mb-2 text-sm text-gray-400">
									👥 Team Members ({group.members?.length || 0})
								</p>
								<div class="max-h-24 space-y-1 overflow-y-auto">
									{#each group.members as member}
										<div class="flex items-center gap-2 text-sm">
											<span>{member.isLeader ? "👑" : "🎤"}</span>
											<span class="truncate text-gray-300">{member.user.name}</span>
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
		<div class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
			<button
				type="button"
				class="fixed inset-0 bg-black/80"
				onclick={closeCreateModal}
				aria-label="Close create modal"
			></button>
			<div
				class="animate-in fade-in slide-in-from-bottom-4 relative w-full max-w-lg rounded-xl border border-purple-700 bg-theater-dark p-6 shadow-2xl duration-200"
			>
				<div class="mb-4 flex items-center justify-between">
					<h3 class="flex items-center gap-2 text-xl font-bold sm:text-2xl">
						<span class="text-2xl">✨</span>
						Create New Presentation
					</h3>
					<button onclick={closeCreateModal} class="text-2xl text-gray-400 hover:text-white"
						>✕</button
					>
				</div>
				<form
					method="POST"
					action="?/createGroup"
					use:enhance={() => {
						return async ({ result }) => {
							if (result.type === "success") {
								closeCreateModal();
								await invalidateAll();
							}
						};
					}}
					class="space-y-4"
				>
					<div>
						<label for="create-emoji-modal" class="mb-2 block text-gray-300"
							>Emoji (single emoji only)</label
						>
						<input
							id="create-emoji-modal"
							type="text"
							name="emoji"
							bind:value={selectedEmoji}
							maxlength="2"
							oninput={(e) => {
								const value = e.currentTarget.value;
								const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
								const segments = Array.from(segmenter.segment(value));
								if (segments.length > 1) {
									e.currentTarget.value = segments[0].segment;
									selectedEmoji = segments[0].segment;
								}
							}}
							placeholder="Type or pick emoji"
							class="mb-3 w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-3 text-center text-2xl text-white placeholder:text-base placeholder:text-gray-500 focus:border-theater-purple focus:outline-none"
						/>
						<div class="mb-2 text-center text-xs text-gray-400">Quick picks:</div>
						<div
							class="grid grid-cols-8 gap-2 rounded-lg border border-gray-700 bg-theater-darker p-3"
						>
							{#each emojiOptions as emoji}
								<button
									type="button"
									onclick={() => (selectedEmoji = emoji)}
									class="rounded-lg p-2 text-2xl transition hover:bg-theater-purple/20 {selectedEmoji ===
									emoji
										? 'bg-theater-purple ring-2 ring-theater-purple'
										: 'hover:scale-110'}">{emoji}</button
								>
							{/each}
						</div>
					</div>
					<div>
						<label for="groupName-modal" class="mb-2 block text-gray-300">Presentation Name</label>
						<input
							id="groupName-modal"
							name="name"
							type="text"
							required
							placeholder="Enter a name for your presentation"
							class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-3 text-white placeholder:text-gray-500 focus:border-theater-purple focus:outline-none"
						/>
					</div>
					{#if form?.error}
						<p class="text-sm text-red-400">{form.error}</p>
					{/if}
					<div class="flex gap-3">
						<button
							type="button"
							onclick={closeCreateModal}
							class="flex-1 rounded-lg bg-gray-700 py-3 font-semibold text-white transition hover:bg-gray-600"
							>Cancel</button
						>
						<button
							type="submit"
							class="flex-1 rounded-lg bg-theater-purple py-3 font-bold text-white transition hover:bg-purple-600"
							>✨ Create</button
						>
					</div>
				</form>
			</div>
		</div>
	{/if}

	<!-- === JOIN PRESENTATION MODAL === -->
	{#if showJoinModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
			<button
				type="button"
				class="fixed inset-0 bg-black/80"
				onclick={closeJoinModal}
				aria-label="Close join modal"
			></button>
			<div
				class="animate-in fade-in slide-in-from-bottom-4 relative w-full max-w-lg rounded-xl border border-purple-700 bg-theater-dark p-6 shadow-2xl duration-200"
			>
				<div class="mb-4 flex items-center justify-between">
					<h3 class="flex items-center gap-2 text-xl font-bold sm:text-2xl">
						<span class="text-2xl">🤝</span>
						Join a Presentation Team
					</h3>
					<button onclick={closeJoinModal} class="text-2xl text-gray-400 hover:text-white">✕</button
					>
				</div>
				<form
					method="POST"
					action="?/joinGroup"
					use:enhance={() => {
						return async ({ result }) => {
							if (result.type === "success") {
								closeJoinModal();
								await invalidateAll();
							}
						};
					}}
					class="space-y-4"
				>
					<div>
						<label for="inviteCode-modal" class="mb-2 block text-gray-300">Invite Code</label>
						<input
							id="inviteCode-modal"
							name="inviteCode"
							type="text"
							required
							placeholder="Enter 8-character code"
							maxlength="8"
							class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-3 text-center font-mono text-xl uppercase tracking-widest text-white placeholder:text-gray-500 focus:border-theater-purple focus:outline-none"
						/>
						<p class="mt-2 text-xs text-gray-400">
							Get the invite code from your presentation leader.
						</p>
					</div>
					{#if form?.error}
						<p class="text-sm text-red-400">{form.error}</p>
					{/if}
					<div class="flex gap-3">
						<button
							type="button"
							onclick={closeJoinModal}
							class="flex-1 rounded-lg bg-gray-700 py-3 font-semibold text-white transition hover:bg-gray-600"
							>Cancel</button
						>
						<button
							type="submit"
							class="flex-1 rounded-lg bg-theater-purple py-3 font-bold text-white transition hover:bg-purple-600"
							>🤝 Join Team</button
						>
					</div>
				</form>
			</div>
		</div>
	{/if}

	<!-- === CATEGORIES MODAL === -->
	{#if showCategoriesModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
			<button
				type="button"
				class="fixed inset-0 bg-black/80"
				onclick={closeCategoriesModal}
				aria-label="Close categories modal"
			></button>
			<div
				class="animate-in fade-in slide-in-from-bottom-4 relative w-full max-w-2xl rounded-xl border border-purple-700 bg-theater-dark p-6 shadow-2xl duration-200"
			>
				<div class="mb-4 flex items-center justify-between">
					<h3 class="text-xl font-bold sm:text-2xl">📊 Manage Rating Categories</h3>
					<button onclick={closeCategoriesModal} class="text-2xl text-gray-400 hover:text-white"
						>✕</button
					>
				</div>
				<p class="mb-4 text-sm text-gray-400">
					Categories will be used for rating presentations during the live event. Reorder them to
					change the display order.
				</p>

				<div class="mb-6 max-h-96 space-y-3 overflow-y-auto">
					{#each editingCategories as category, index}
						<div class="rounded-lg border border-gray-700 bg-theater-darker p-4">
							<div class="mb-3 flex items-start gap-3">
								<div class="flex flex-col gap-1 pt-2">
									<button
										type="button"
										onclick={() => moveCategoryUp(index)}
										disabled={index === 0}
										class="rounded bg-gray-700 px-2 py-1 text-xs text-white transition hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-30"
										title="Move up"
									>
										▲
									</button>
									<button
										type="button"
										onclick={() => moveCategoryDown(index)}
										disabled={index === editingCategories.length - 1}
										class="rounded bg-gray-700 px-2 py-1 text-xs text-white transition hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-30"
										title="Move down"
									>
										▼
									</button>
								</div>
								<div class="flex-1 space-y-3">
									<div>
										<label for="category-name-{index}" class="mb-1 block text-sm text-gray-300">
											Category Name <span class="text-red-400">*</span>
										</label>
										<input
											id="category-name-{index}"
											type="text"
											bind:value={category.name}
											placeholder="e.g., Content Quality, Presentation Style"
											required
											class="w-full rounded-lg border border-gray-700 bg-theater-dark px-3 py-2 text-white placeholder:text-gray-500 focus:border-theater-purple focus:outline-none"
										/>
									</div>
									<div>
										<label for="category-desc-{index}" class="mb-1 block text-sm text-gray-300">
											Description (optional)
										</label>
										<input
											id="category-desc-{index}"
											type="text"
											bind:value={category.description}
											placeholder="Brief description of what to rate"
											class="w-full rounded-lg border border-gray-700 bg-theater-dark px-3 py-2 text-white placeholder:text-gray-500 focus:border-theater-purple focus:outline-none"
										/>
									</div>
								</div>
								<button
									type="button"
									onclick={() => removeCategory(index)}
									class="flex-shrink-0 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-700"
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
					class="mb-4 w-full rounded-lg bg-gray-700 py-2 font-semibold text-white transition hover:bg-gray-600"
				>
					➕ Add Category
				</button>

				<div class="flex gap-3">
					<button
						type="button"
						onclick={closeCategoriesModal}
						class="flex-1 rounded-lg bg-gray-700 py-3 font-semibold text-white transition hover:bg-gray-600"
						>Cancel</button
					>
					<button
						type="button"
						onclick={saveCategories}
						class="flex-1 rounded-lg bg-theater-purple py-3 font-bold text-white transition hover:bg-purple-600"
						>💾 Save Categories</button
					>
				</div>
			</div>
		</div>
	{/if}

	<!-- === GROUP MANAGEMENT DRAWER (modal, unchanged) === -->
	{#if managedGroupId}
		{@const managed = data.userGroups.find((ug: any) => ug.group.id === managedGroupId)}
		{#if managed}
			<div
				class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-2 sm:p-4 md:p-8"
			>
				<button
					type="button"
					class="fixed inset-0 cursor-default bg-black/80"
					onclick={closeManage}
					aria-label="Close management panel"
				></button>
				<div
					class="animate-in fade-in slide-in-from-bottom-4 relative my-auto w-full max-w-4xl overflow-hidden rounded-xl border border-gray-800 bg-theater-dark shadow-2xl duration-200"
				>
					<div class="flex items-start justify-between border-b border-gray-800 p-4 sm:p-6">
						<div class="mr-2 flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
							<span class="flex-shrink-0 text-2xl sm:text-3xl">{managed.group.emoji || "📊"}</span>
							<div class="min-w-0 flex-1">
								<h3 class="break-words text-xl font-bold sm:text-2xl">{managed.group.name}</h3>
								<p class="text-xs text-gray-400 sm:text-sm">
									{managed.group.members.length} member{managed.group.members.length === 1
										? ""
										: "s"}
								</p>
							</div>
						</div>
						<button
							class="flex-shrink-0 p-1 text-xl text-gray-400 hover:text-white sm:text-2xl"
							onclick={closeManage}>✕</button
						>
					</div>
					<div class="px-3 pt-3 sm:px-6 sm:pt-4">
						<div class="mb-3 flex gap-1 overflow-x-auto sm:mb-4 sm:gap-2">
							<button
								class="whitespace-nowrap rounded-lg border px-3 py-2 text-xs sm:px-4 sm:text-base {activeTab ===
								'members'
									? 'border-theater-purple text-white'
									: 'border-gray-700 text-gray-300'}"
								onclick={() => (activeTab = "members")}>Members</button
							>
							<button
								class="whitespace-nowrap rounded-lg border px-3 py-2 text-xs sm:px-4 sm:text-base {activeTab ===
								'presentation'
									? 'border-theater-purple text-white'
									: 'border-gray-700 text-gray-300'}"
								onclick={() => (activeTab = "presentation")}>Presentation</button
							>
							<button
								class="whitespace-nowrap rounded-lg border px-3 py-2 text-xs sm:px-4 sm:text-base {activeTab ===
								'danger'
									? 'border-red-600 text-red-400'
									: 'border-gray-700 text-gray-300'}"
								onclick={() => (activeTab = "danger")}>Danger Zone</button
							>
						</div>
					</div>
					<div class="space-y-4 p-3 sm:space-y-6 sm:p-6">
						{#if activeTab === "members"}
							<div>
								<h4 class="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">
									Team Members
								</h4>
								<div class="space-y-2">
									{#each managed.group.members as member}
										{@const badge = getMemberBadge(
											member.isLeader,
											member.userId === data.user?.id,
										)}
										<div
											class="glass flex items-center justify-between rounded-lg border border-gray-800 px-4 py-3"
										>
											<div class="flex items-center gap-3">
												<span class="text-lg">{member.isLeader ? "👑" : "🎤"}</span>
												<span class="font-semibold text-white">{member.user.name}</span>
												<span class="rounded-full px-2 py-1 text-xs {badge.color}"
													>{badge.text}</span
												>
											</div>
											{#if managed.isLeader && member.userId !== data.user?.id}
												<form method="POST" action="?/removeMember" use:enhance>
													<input type="hidden" name="groupId" value={managed.group.id} />
													<input type="hidden" name="userId" value={member.userId} />
													<button
														type="submit"
														class="text-sm font-semibold text-red-400 transition hover:text-red-300"
														>🗑️ Remove</button
													>
												</form>
											{/if}
										</div>
									{/each}
								</div>
								{#if managed.isLeader}
									<div class="mt-4">
										<p class="mb-2 text-sm text-gray-400">Invite Code</p>
										<div class="flex items-center gap-2">
											<code
												class="flex-1 rounded-lg border border-gray-700 bg-theater-darker px-4 py-3 font-mono text-lg font-bold tracking-wider text-purple-300"
												>{managed.group.inviteCode}</code
											>
											<button
												onclick={() => copyInviteCode(managed.group.inviteCode)}
												class="rounded-lg bg-theater-purple px-4 py-3 text-sm font-semibold text-white transition hover:bg-purple-600"
												>📋 Copy</button
											>
										</div>
									</div>
								{/if}
							</div>
						{/if}
						{#if activeTab === "presentation"}
							{#if managed.isLeader}
								<div class="mb-4 rounded-lg border border-gray-700 bg-theater-dark p-4">
									<div class="mb-3 flex items-center justify-between">
										<h5 class="text-sm font-semibold uppercase tracking-wide text-gray-400">
											Presentation Identity
										</h5>
									</div>
									<form method="POST" action="?/updateGroup" use:enhance class="space-y-4">
										<input type="hidden" name="groupId" value={managed.group.id} />
										<div>
											<label
												for="edit-emoji-{managed.group.id}"
												class="mb-2 block text-sm text-gray-300">Emoji (single emoji only)</label
											>
											<input
												id="edit-emoji-{managed.group.id}"
												type="text"
												name="emoji"
												bind:value={editEmoji}
												maxlength="2"
												oninput={(e) => {
													const value = e.currentTarget.value;
													const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
													const segments = Array.from(segmenter.segment(value));
													if (segments.length > 1) {
														e.currentTarget.value = segments[0].segment;
														editEmoji = segments[0].segment;
													}
												}}
												placeholder="Type or pick emoji"
												class="mb-3 w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-3 text-center text-2xl text-white placeholder:text-base placeholder:text-gray-500 focus:border-theater-purple focus:outline-none"
											/>
											<div class="mb-2 text-center text-xs text-gray-400">Quick picks:</div>
											<div
												class="grid grid-cols-8 gap-2 rounded-lg border border-gray-700 bg-theater-darker p-3"
											>
												{#each emojiOptions as emoji}
													<button
														type="button"
														onclick={() => (editEmoji = emoji)}
														class="rounded-lg p-2 text-2xl transition hover:bg-theater-purple/20 {editEmoji ===
														emoji
															? 'bg-theater-purple ring-2 ring-theater-purple'
															: 'hover:scale-110'}">{emoji}</button
													>
												{/each}
											</div>
										</div>
										<div>
											<label
												for="edit-name-{managed.group.id}"
												class="mb-2 block text-sm text-gray-300">Presentation Name</label
											>
											<input
												id="edit-name-{managed.group.id}"
												name="name"
												required
												bind:value={editName}
												class="w-full rounded-lg border border-gray-700 bg-theater-darker px-4 py-3 text-white placeholder:text-gray-500 focus:border-theater-purple focus:outline-none"
											/>
										</div>
										<div class="flex gap-2">
											<button
												type="submit"
												class="flex-1 rounded-lg bg-theater-purple py-2 font-semibold text-white transition hover:bg-purple-600"
												>💾 Save</button
											>
											<button
												type="button"
												onclick={() => {
													editEmoji = managed.group.emoji || "📊";
													editName = managed.group.name;
												}}
												class="rounded-lg bg-gray-700 px-4 py-2 font-semibold text-white transition hover:bg-gray-600"
												>Reset</button
											>
										</div>
									</form>
								</div>
							{/if}
							<div class="rounded-lg border border-gray-700 p-4">
								<h5 class="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-400">
									Presentation Submission
								</h5>
								{#if (data.event as any).submissionsClosed}
									<div class="rounded-lg border border-yellow-500/30 bg-yellow-900/30 p-4">
										<p class="font-semibold text-yellow-400">
											🔒 Submissions are closed for this event
										</p>
										{#if managed.group.status === "submitted" && managed.group.submissionLink}
											<div class="mt-3 border-t border-yellow-500/30 pt-3">
												<p class="mb-1 text-sm text-gray-400">Your submitted link:</p>
												<a
													href={managed.group.submissionLink}
													target="_blank"
													class="break-all text-sm text-blue-400 underline hover:text-blue-300"
													>{managed.group.submissionLink}</a
												>
											</div>
										{/if}
									</div>
								{:else}
									{#if managed.group.status === "submitted" && managed.group.submissionLink}
										<div class="mb-4 rounded-lg border border-green-500/30 bg-green-900/30 p-4">
											<p class="mb-2 text-sm font-bold uppercase tracking-wide text-green-300">
												✅ Current Submission
											</p>
											<a
												href={managed.group.submissionLink}
												target="_blank"
												class="break-all text-sm text-blue-400 underline hover:text-blue-300"
												>{managed.group.submissionLink}</a
											>
											<p class="mt-2 text-xs text-gray-400">Submit again below to update.</p>
										</div>
									{/if}
									<form method="POST" action="?/submitPresentation" use:enhance class="space-y-3">
										<input type="hidden" name="groupId" value={managed.group.id} />
										<label
											for="submissionLink-{managed.group.id}"
											class="mb-1 block text-sm font-semibold text-gray-300"
											>{managed.group.status === "submitted"
												? "Update Presentation Link (optional)"
												: "Presentation Link (optional)"}</label
										>
										<input
											id="submissionLink-{managed.group.id}"
											name="submissionLink"
											type="url"
											placeholder="https://slides.google.com/..."
											value={managed.group.status === "submitted"
												? managed.group.submissionLink
												: ""}
											class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-3 text-white transition placeholder:text-gray-500 focus:border-theater-purple focus:outline-none"
										/>
										<button
											type="submit"
											class="w-full rounded-lg bg-theater-purple py-3 text-lg font-bold text-white transition hover:bg-purple-600"
											>{managed.group.status === "submitted"
												? "🔄 Update Presentation"
												: "🎯 Submit Presentation"}</button
										>
									</form>
								{/if}
							</div>
						{/if}
						{#if activeTab === "danger" && managed.isLeader}
							<div class="border-t border-gray-700 pt-2"></div>
							<div>
								<h5 class="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-400">
									Danger Zone
								</h5>
								<form method="POST" action="?/deleteGroup" use:enhance>
									<input type="hidden" name="groupId" value={managed.group.id} />
									<button
										type="submit"
										class="w-full rounded-lg bg-red-600 py-3 font-semibold text-white transition hover:bg-red-700"
										onclick={(e) => {
											if (
												!confirm(
													"Delete this presentation? This removes all members and cannot be undone.",
												)
											)
												e.preventDefault();
										}}>🗑️ Delete Presentation</button
									>
								</form>
								<p class="mt-2 text-center text-xs text-gray-500">This cannot be undone.</p>
							</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	{/if}
</PageContainer>
