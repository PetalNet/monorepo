<script lang="ts">
	import { goto } from "$app/navigation";
	import PageContainer from "$lib/components/PageContainer.svelte";
	import PageHeader from "$lib/components/PageHeader.svelte";
	import { COMMON_TIMEZONES, getUserTimezone } from "$lib/utils/timezone";

	let loading = $state(false);
	let error = $state("");

	// Form state
	let name = $state("");
	let theme = $state("");
	let description = $state("");
	let submissionDeadline = $state("");
	let maxPresentationTime = $state("");
	let orderMode = $state("random");
	let timezone = $state(getUserTimezone() || "America/New_York");

	// Categories
	let categories = $state([
		{ name: "Creativity", description: "How creative and original is the presentation?" },
		{ name: "Delivery", description: "How well was it presented?" },
		{ name: "Entertainment", description: "How entertaining was it?" },
	]);

	function addCategory() {
		categories = [...categories, { name: "", description: "" }];
	}

	function removeCategory(index: number) {
		categories = categories.filter((_, i) => i !== index);
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		loading = true;
		error = "";

		// Validate categories
		const validCategories = categories.filter((c) => c.name.trim() !== "");
		if (validCategories.length === 0) {
			error = "Please add at least one rating category";
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
			categories: validCategories,
		};

		const response = await fetch("/event/create", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(formData),
		});

		if (response.ok) {
			const data = await response.json();
			goto(`/night/${data.joinCode}`);
		} else {
			const data = await response.json();
			error = data.error || "An error occurred";
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
		<div class="glass space-y-4 rounded-xl p-6">
			<h2 class="mb-4 text-2xl font-semibold">Basic Information</h2>

			<div>
				<label for="name" class="mb-2 block text-sm font-medium">Event Name *</label>
				<input
					id="name"
					type="text"
					bind:value={name}
					required
					class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
					placeholder="Movie Night 2025"
				/>
			</div>

			<div>
				<label for="theme" class="mb-2 block text-sm font-medium">Theme (Optional)</label>
				<input
					id="theme"
					type="text"
					bind:value={theme}
					class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
					placeholder="Movies, Travel, Food..."
				/>
			</div>

			<div>
				<label for="description" class="mb-2 block text-sm font-medium"
					>Description (Optional)</label
				>
				<textarea
					id="description"
					bind:value={description}
					rows="3"
					class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
					placeholder="What's this event about?"></textarea>
			</div>
		</div>

		<!-- Timing & Settings -->
		<div class="glass space-y-4 rounded-xl p-6">
			<h2 class="mb-4 text-2xl font-semibold">Settings</h2>

			<div>
				<label for="timezone" class="mb-2 block text-sm font-medium">Event Timezone *</label>
				<select
					id="timezone"
					bind:value={timezone}
					class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-2 text-white [color-scheme:dark] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
				>
					{#each COMMON_TIMEZONES as tz}
						<option value={tz.value}>{tz.label}</option>
					{/each}
				</select>
				<p class="mt-1 text-xs text-gray-500">
					All times for this event will be displayed in this timezone. Deadline will be at {COMMON_TIMEZONES.find(
						(tz) => tz.value === timezone,
					)?.label || timezone}.
				</p>
			</div>

			<div>
				<label for="submissionDeadline" class="mb-2 block text-sm font-medium"
					>Submission Deadline (optional)</label
				>
				<input
					id="submissionDeadline"
					type="datetime-local"
					bind:value={submissionDeadline}
					class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-2 text-white focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
				/>
				<p class="mt-1 text-xs text-gray-500">
					Enter time in <strong
						>{COMMON_TIMEZONES.find((tz) => tz.value === timezone)?.label || timezone}</strong
					>
				</p>
			</div>
			<div>
				<label for="maxTime" class="mb-2 block text-sm font-medium"
					>Max Presentation Time (minutes, optional)</label
				>
				<input
					id="maxTime"
					type="number"
					bind:value={maxPresentationTime}
					min="1"
					max="60"
					placeholder="e.g., 5"
					class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
				/>
				<p class="mt-1 text-xs text-gray-500">
					How long should each presentation be? Leave blank for no limit.
				</p>
			</div>

			<div>
				<label for="orderMode" class="mb-2 block text-sm font-medium">Presentation Order *</label>
				<select
					id="orderMode"
					bind:value={orderMode}
					class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-2 text-white focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
				>
					<option value="random">Random</option>
					<option value="alphabetical">Alphabetical</option>
				</select>
				<p class="mt-1 text-xs text-gray-500">You can manually reorder presentations later.</p>
			</div>
		</div>

		<!-- Rating Categories -->
		<div class="glass space-y-4 rounded-xl p-6">
			<div class="mb-4 flex items-center justify-between">
				<h2 class="text-2xl font-semibold">Rating Categories</h2>
				<button
					type="button"
					onclick={addCategory}
					class="rounded-lg bg-gray-700 px-3 py-1 text-sm font-semibold transition-all duration-200 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-theater-darker"
				>
					+ Add Category
				</button>
			</div>
			<p class="mb-4 text-sm text-gray-400">
				Define what criteria judges will rate presentations on (1-5 stars)
			</p>

			{#each categories as category, index}
				<div class="space-y-3 rounded-lg border border-gray-700 bg-theater-darker p-4">
					<div class="flex items-start justify-between gap-3">
						<div class="flex-1">
							<label for="cat-name-{index}" class="mb-2 block text-sm font-medium"
								>Category Name *</label
							>
							<input
								id="cat-name-{index}"
								type="text"
								bind:value={category.name}
								placeholder="e.g., Creativity, Delivery, Impact"
								class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
							/>
						</div>
						{#if categories.length > 1}
							<button
								type="button"
								onclick={() => removeCategory(index)}
								class="mt-7 rounded-lg px-3 py-2 text-red-400 transition-colors hover:bg-red-900/20 hover:text-red-300"
								title="Remove category"
							>
								✕
							</button>
						{/if}
					</div>
					<div>
						<label for="cat-desc-{index}" class="mb-2 block text-sm font-medium"
							>Description (Optional)</label
						>
						<input
							id="cat-desc-{index}"
							type="text"
							bind:value={category.description}
							placeholder="What should judges consider?"
							class="w-full rounded-lg border border-gray-700 bg-theater-dark px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-theater-purple"
						/>
					</div>
				</div>
			{/each}
		</div>

		<!-- Error Display -->
		{#if error}
			<div class="rounded-lg border border-red-500 bg-red-900/30 px-4 py-3 text-red-200">
				{error}
			</div>
		{/if}

		<!-- Submit Buttons -->
		<div class="flex gap-3">
			<button
				type="button"
				onclick={() => goto("/dashboard")}
				class="rounded-lg bg-gray-700 px-6 py-3 font-semibold transition-all duration-200 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-theater-darker"
			>
				Cancel
			</button>
			<button
				type="submit"
				disabled={loading}
				class="flex-1 rounded-lg bg-theater-purple px-6 py-3 font-semibold transition-all duration-200 hover:bg-purple-600 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:ring-offset-2 focus:ring-offset-theater-darker disabled:cursor-not-allowed disabled:opacity-50"
			>
				{loading ? "Creating Event..." : "Create Event"}
			</button>
		</div>
	</form>
</PageContainer>
