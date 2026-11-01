<script lang="ts" module>
	export interface Person {
		key: number;
		name: string;
	}

	let nextKey = 0;

	export function newPerson(name = ""): Person {
		nextKey += 1;

		return { key: nextKey, name };
	}

	/** Named +1s first, then a blank row for each slot an older RSVP never named. */
	export function peopleFor(guestCount: number, guestNames: readonly string[]): Person[] {
		const blanks = Math.max(0, guestCount - 1 - guestNames.length);

		return [
			...guestNames.map((name) => newPerson(name)),
			...Array.from({ length: blanks }, () => newPerson()),
		];
	}
</script>

<script lang="ts">
	import { MAX_PLUS_ONES } from "$lib/guests";
	import { Plus } from "@lucide/svelte";
	import { tick } from "svelte";

	import PlusOnePersonRow from "./PlusOnePersonRow.svelte";

	let {
		people = $bindable<Person[]>([]),
		error,
		maxPlusOnes = null,
	}: { people?: Person[]; error?: string; maxPlusOnes?: number | null } = $props();

	let list = $state<HTMLUListElement>();
	let addButton = $state<HTMLButtonElement>();

	const cap = $derived(Math.min(maxPlusOnes ?? MAX_PLUS_ONES, MAX_PLUS_ONES));
	const full = $derived(people.length >= cap);

	function inputFor(person: Person | undefined) {
		return person
			? list?.querySelector<HTMLInputElement>(`input[data-person-key="${person.key}"]`)
			: undefined;
	}

	async function add() {
		if (full) {
			return;
		}

		const person = newPerson();

		people.push(person);
		await tick();
		inputFor(person)?.focus();
	}

	async function remove(index: number) {
		people.splice(index, 1);
		await tick();

		(inputFor(people[index]) ?? addButton)?.focus();
	}
</script>

{#if error}
	<small class="text-sm text-red-600">{error}</small>
{/if}

{#if cap > 0}
	<div class="plus-ones" role="group" aria-labelledby="plus-ones-label">
		<span class="status-label" id="plus-ones-label">Bringing anyone?</span>

		{#if people.length > 0}
			<ul class="plus-ones-list" bind:this={list}>
				{#each people as person, index (person.key)}
					<PlusOnePersonRow {person} {index} onremove={remove} />
				{/each}
			</ul>
		{/if}

		{#if !full}
			<button type="button" class="btn-secondary plus-ones-add" bind:this={addButton} onclick={add}>
				<Plus size={18} aria-hidden="true" /> Add a person
			</button>
		{/if}
	</div>
{/if}

<style>
	.plus-ones {
		display: grid;
		gap: 0.5rem;
		margin-block: 0.75rem 0.25rem;
	}

	.plus-ones-list {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.plus-ones-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		justify-self: start;
		transition: none;
	}

	.plus-ones-add:hover {
		transform: none;
	}

	@media (max-width: 640px) {
		.plus-ones-add {
			justify-self: stretch;
		}
	}
</style>
