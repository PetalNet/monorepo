<script lang="ts">
	import {
		parsePotluckAnswer,
		standings,
		unclaimedIdeas,
		type PotluckAnswer,
		type PotluckView,
	} from "$lib/potluck";
	import { tick, untrack } from "svelte";
	import { fly } from "svelte/transition";

	import PotluckCategoryChips from "./PotluckCategoryChips.svelte";

	let {
		questionId,
		label,
		required = false,
		view,
		value = "",
		ownAnswer = null,
		offeredOverride = null,
		onchange,
	}: {
		questionId: string;
		label: string;
		required?: boolean;
		view: PotluckView;
		value?: string;
		ownAnswer?: PotluckAnswer | null;
		offeredOverride?: string[] | null;
		onchange: (raw: string) => void;
	} = $props();

	const initial = untrack(() => parsePotluckAnswer(value));
	let category = $state(initial?.category ?? "");
	let dish = $state(initial?.dish ?? "");
	let optedOut = $state(false);
	let dishInput = $state<HTMLInputElement>();

	// A guest editing an RSVP replaces their old count with their in-progress selection.
	const countsWithoutOwn = $derived.by(() => {
		if (!ownAnswer) {
			return view.counts;
		}

		return {
			...view.counts,
			[ownAnswer.category]: Math.max(0, (view.counts[ownAnswer.category] ?? 1) - 1),
		};
	});
	const displayedCounts = $derived(
		category
			? { ...countsWithoutOwn, [category]: (countsWithoutOwn[category] ?? 0) + 1 }
			: countsWithoutOwn,
	);
	const offeredCategoryIds = $derived(
		standings(view.config, countsWithoutOwn)
			.filter((standing) => standing.reason !== "closed")
			.map((standing) => standing.category.id),
	);
	const categories = $derived(
		view.config.categories.map((item) => ({
			category: item,
			offered:
				item.id === ownAnswer?.category ||
				(offeredOverride
					? offeredOverride.includes(item.id)
					: offeredCategoryIds.includes(item.id)),
		})),
	);
	const takenDishes = (id: string) =>
		view.taken.filter((item) => item.category === id).map((item) => item.dish);
	const selected = $derived(view.config.categories.find((item) => item.id === category) ?? null);
	const ideas = $derived(
		selected ? unclaimedIdeas(selected, takenDishes(selected.id)).slice(0, 2) : [],
	);
	const placeholder = $derived(
		ideas.length > 0 ? `e.g. ${ideas.join(", ")}` : "What are you bringing?",
	);
	const raw = $derived(
		category && dish.trim() ? JSON.stringify({ category, dish: dish.trim() }) : "",
	);
	const motionDuration = () =>
		typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
			? 0
			: 160;

	$effect(() => onchange(raw));

	$effect(() => {
		if (category && !categories.some((item) => item.category.id === category && item.offered)) {
			category = "";
		}
	});

	async function chooseCategory(nextCategory: string) {
		category = nextCategory;
		optedOut = false;
		await tick();
		dishInput?.focus();
	}
</script>

<fieldset class="potluck-field" role="radiogroup" aria-label={label}>
	<legend>{label}{required ? " *" : ""}</legend>
	{#if view.config.providing}
		<small
			class="potluck-providing"
			title={view.config.providing}
			aria-label={`Hosts are providing: ${view.config.providing}`}
			><strong>Hosts are providing:</strong> {view.config.providing}</small
		>
	{/if}

	<input type="hidden" name="response_{questionId}" value={raw} />

	<PotluckCategoryChips
		{questionId}
		{categories}
		selected={category}
		counts={displayedCounts}
		{required}
		{optedOut}
		onchoose={(categoryId) => void chooseCategory(categoryId)}
		onskip={() => {
			category = "";
			optedOut = true;
		}}
	/>

	{#if category && !optedOut}
		<div class="potluck-dish" in:fly={{ y: -6, duration: motionDuration() }}>
			<label class="form-label" for="dish-{questionId}">
				<span>Your dish{required || category ? " *" : ""}</span>
				<input
					class="input-field"
					id="dish-{questionId}"
					type="text"
					maxlength="80"
					bind:this={dishInput}
					bind:value={dish}
					required
					{placeholder}
				/>
			</label>
		</div>
	{/if}
</fieldset>

<style>
	.potluck-field {
		display: grid;
		gap: 0.5rem;
		min-width: 0;
	}

	.potluck-field legend {
		color: var(--event-text-primary, #1b1430);
		font-weight: 600;
	}

	.potluck-providing {
		display: block;
		overflow: hidden;
		color: var(--event-text-secondary, #362a54);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.potluck-dish {
		display: grid;
		gap: 0.25rem;
		padding-top: 0.125rem;
	}

	:global(html.dark) .potluck-field legend {
		color: var(--event-text-primary-dark, #fff);
	}

	:global(html.dark) .potluck-providing {
		color: var(--event-text-secondary-dark, #d9d8f5);
	}
</style>
