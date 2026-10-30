<script lang="ts">
	import {
		parsePotluckAnswer,
		standings,
		unclaimedIdeas,
		type PotluckAnswer,
		type PotluckView,
	} from "$lib/potluck";
	import { untrack } from "svelte";

	let {
		questionId,
		label,
		description = null,
		required = false,
		view,
		value = "",
		ownAnswer = null,
		offeredOverride = null,
		accentStyle = "",
		onchange,
	}: {
		questionId: string;
		label: string;
		description?: string | null;
		required?: boolean;
		view: PotluckView;
		value?: string;
		ownAnswer?: PotluckAnswer | null;
		offeredOverride?: string[] | null;
		accentStyle?: string;
		onchange: (raw: string) => void;
	} = $props();

	const initial = untrack(() => parsePotluckAnswer(value));
	let category = $state(initial?.category ?? "");
	let dish = $state(initial?.dish ?? "");
	// Only an explicit click opts out; a category closing under the guest must not look like one.
	let optedOut = $state(false);
	let dishInput: HTMLInputElement | undefined = $state();

	// A guest editing their RSVP should not be blocked by their own dish.
	const counts = $derived.by(() => {
		if (!ownAnswer) {
			return view.counts;
		}

		return {
			...view.counts,
			[ownAnswer.category]: Math.max(0, (view.counts[ownAnswer.category] ?? 1) - 1),
		};
	});

	const ranked = $derived(
		standings(view.config, counts).map((s) => ({
			...s,
			offered:
				s.category.id === ownAnswer?.category ||
				(offeredOverride ? offeredOverride.includes(s.category.id) : s.reason !== "closed"),
		})),
	);
	const open = $derived(ranked.filter((s) => s.offered));
	const full = $derived(ranked.filter((s) => !s.offered));
	const neededMost = $derived(open.find((s) => s.deficit >= 1)?.category.id ?? null);

	const takenDishes = (id: string) =>
		view.taken.filter((t) => t.category === id).map((t) => t.dish);

	$effect(() => {
		if (category && !open.some((s) => s.category.id === category)) {
			category = "";
		}
	});

	const raw = $derived(
		category && dish.trim() ? JSON.stringify({ category, dish: dish.trim() }) : "",
	);

	$effect(() => onchange(raw));

	$effect(() => {
		dishInput?.setCustomValidity(dish.trim() && !category ? "Pick a category for your dish" : "");
	});
</script>

<fieldset>
	<legend>{label}{required ? " *" : ""}</legend>
	{#if description}
		<small class="block text-sm text-gray-600">{description}</small>
	{/if}
	{#if view.config.providing}
		<small class="block text-sm text-gray-600"
			><strong>Hosts are providing:</strong> {view.config.providing}</small
		>
	{/if}

	<input type="hidden" name="response_{questionId}" value={raw} />

	<div class="status-options">
		{#each open as s (s.category.id)}
			{@const ideas = unclaimedIdeas(s.category, takenDishes(s.category.id))}
			<label class="status-option">
				<input
					type="radio"
					name="potluck_category_{questionId}"
					value={s.category.id}
					checked={category === s.category.id}
					onchange={() => {
						category = s.category.id;
						optedOut = false;
					}}
				/>
				<span class="flex-1">
					{s.category.label}
					{#if s.category.id === neededMost}
						<small
							class="badge-status ml-2 px-2 py-0.5 text-xs"
							data-tone="theme"
							style={accentStyle}>Needed most</small
						>
					{/if}
					<small class="mt-1 block text-sm text-gray-600"
						>{s.count} so far{#if ideas.length > 0}. Ideas: {ideas.join(", ")}{/if}</small
					>
				</span>
			</label>
		{/each}
		{#if !required}
			<label class="status-option">
				<input
					type="radio"
					name="potluck_category_{questionId}"
					value=""
					checked={optedOut}
					onchange={() => {
						category = "";
						optedOut = true;
					}}
				/>
				<span class="flex-1">Not bringing a dish</span>
			</label>
		{/if}
	</div>

	{#if full.length > 0}
		<small class="text-sm text-gray-600"
			>Full for now: {full.map((s) => s.category.label).join(", ")}. Pick from what's still needed
			above.</small
		>
	{/if}

	{#if !optedOut}
		<label class="form-label">
			<span>Your dish{required || category ? " *" : ""}</span>
			<input
				class="input-field"
				type="text"
				maxlength="80"
				bind:this={dishInput}
				bind:value={dish}
				required={required || Boolean(category)}
				placeholder={category ? "What are you bringing?" : "Pick a category first"}
			/>
		</label>
	{/if}
</fieldset>

<style>
	/* The event page's dark rule for themed badges is scoped to that page, so mirror it here. */
	:global(.dark) .badge-status[data-tone="theme"] {
		background-color: var(--event-badge-bg-dark) !important;
		color: var(--event-badge-text-dark) !important;
		border-color: var(--event-surface-border-dark) !important;
	}
</style>
