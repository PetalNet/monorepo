<script lang="ts">
	import type { CategoryCounts, PotluckCategory } from "$lib/potluck";

	let {
		questionId,
		categories,
		selected,
		counts,
		required,
		optedOut,
		onchoose,
		onskip,
	}: {
		questionId: string;
		categories: { category: PotluckCategory; offered: boolean }[];
		selected: string;
		counts: CategoryCounts;
		required: boolean;
		optedOut: boolean;
		onchoose: (categoryId: string) => void;
		onskip: () => void;
	} = $props();

	const firstOfferedId = $derived(categories.find((item) => item.offered)?.category.id);
</script>

<div class="potluck-choices">
	{#each categories as item (item.category.id)}
		<label
			class="potluck-choice"
			class:selected={selected === item.category.id}
			class:closed={!item.offered}
		>
			<input
				type="radio"
				name="potluck_category_{questionId}"
				value={item.category.id}
				checked={selected === item.category.id}
				disabled={!item.offered}
				required={required && item.category.id === firstOfferedId}
				onchange={() => onchoose(item.category.id)}
			/>
			<span>{item.category.label}</span>
			<small>{item.offered ? (counts[item.category.id] ?? 0) : "Full"}</small>
		</label>
	{/each}
	{#if !required}
		<label class="potluck-choice potluck-skip" class:selected={optedOut}>
			<input
				type="radio"
				name="potluck_category_{questionId}"
				value=""
				checked={optedOut}
				onchange={onskip}
			/>
			<span>Not bringing a dish</span>
		</label>
	{/if}
</div>

<style>
	.potluck-choices {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}

	.potluck-choice {
		display: flex;
		position: relative;
		align-items: center;
		justify-content: space-between;
		min-height: 44px;
		gap: 0.5rem;
		padding: 0.5rem 0.625rem;
		cursor: pointer;
		border: none;
		border-radius: 0.75rem;
		background: #fff;
		color: var(--event-text-primary, #1b1430);
	}

	.potluck-choice:hover:not(.closed) {
		background: var(--event-primary-50, #f5f3ff);
	}

	.potluck-choice:has(input:focus-visible) {
		outline: 3px solid var(--event-primary-600-alpha, rgba(124, 93, 250, 0.3));
		outline-offset: 2px;
	}

	.potluck-choice.selected {
		background: linear-gradient(135deg, rgba(124, 93, 250, 0.15), rgba(155, 107, 255, 0.1));
		color: var(--event-primary-900, #4c1d95);
	}

	.potluck-choice.closed {
		cursor: not-allowed;
		background: rgba(124, 93, 250, 0.04);
	}

	.potluck-choice input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.potluck-choice span {
		overflow: hidden;
		font-size: 0.875rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.potluck-choice small {
		font-variant-numeric: tabular-nums;
	}

	.potluck-choice.selected small {
		color: inherit;
		opacity: 1;
	}

	.potluck-skip {
		grid-column: 1 / -1;
	}

	:global(html.dark) .potluck-choice {
		background: var(--event-entry-surface-dark, rgba(20, 20, 28, 0.9));
		color: var(--event-text-primary-dark, #f4f3ff);
	}

	:global(html.dark) .potluck-choice:hover:not(.closed) {
		background: rgba(255, 255, 255, 0.1);
	}

	:global(html.dark) .potluck-choice.selected {
		background:
			linear-gradient(135deg, rgba(124, 93, 250, 0.15), rgba(155, 107, 255, 0.1)),
			var(--event-entry-surface-dark, rgba(20, 20, 28, 0.9));
		color: var(--event-text-primary-dark, #f4f3ff);
	}

	:global(html.dark) .potluck-choice.closed {
		background: rgba(255, 255, 255, 0.04);
	}
</style>
