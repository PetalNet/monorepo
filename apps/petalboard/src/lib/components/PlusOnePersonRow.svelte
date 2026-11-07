<script lang="ts">
	import { MAX_PLUS_ONE_NAME_LENGTH } from "$lib/guests";
	import { X } from "@lucide/svelte";
	import { slide } from "svelte/transition";

	import type { Person } from "./PlusOnesField.svelte";

	let {
		person,
		index,
		onremove,
	}: { person: Person; index: number; onremove: (index: number) => void } = $props();

	function duration() {
		return typeof matchMedia === "function" &&
			matchMedia("(prefers-reduced-motion: reduce)").matches
			? 0
			: 180;
	}
</script>

<li class="plus-ones-row" in:slide={{ duration: duration() }} out:slide={{ duration: duration() }}>
	<input
		class="input-field"
		name="guestName"
		required
		maxlength={MAX_PLUS_ONE_NAME_LENGTH}
		autocomplete="off"
		placeholder="Their name"
		aria-label="Name of person {index + 1}"
		data-person-key={person.key}
		bind:value={person.name}
	/>
	<button
		type="button"
		class="plus-ones-drop"
		aria-label="Remove {person.name.trim() || `person ${index + 1}`}"
		onclick={() => onremove(index)}
	>
		<X size={18} aria-hidden="true" />
	</button>
</li>

<style>
	.plus-ones-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.plus-ones-row :global(.input-field) {
		flex: 1;
		min-width: 0;
	}

	.plus-ones-drop {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		cursor: pointer;
		border: 1px solid rgba(124, 93, 250, 0.25);
		border-radius: 9999px;
		background: transparent;
		color: #5533a5;
	}

	.plus-ones-drop:hover {
		background: rgba(124, 93, 250, 0.12);
	}

	:global(html.dark) .plus-ones-drop {
		border-color: rgba(255, 255, 255, 0.28);
		color: #e6dcff;
	}

	:global(html.dark) .plus-ones-drop:hover {
		background: rgba(255, 255, 255, 0.1);
	}
</style>
