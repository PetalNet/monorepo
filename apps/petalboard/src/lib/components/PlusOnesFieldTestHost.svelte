<script lang="ts">
	import { onMount } from "svelte";

	import PlusOnesField, { type Person } from "./PlusOnesField.svelte";

	let { initialPeople, maxPlusOnes }: { initialPeople: Person[]; maxPlusOnes: number | null } =
		$props();

	let people = $state<Person[]>([]);

	onMount(() => {
		people = initialPeople.map((person) => ({ ...person }));
	});
</script>

<PlusOnesField bind:people {maxPlusOnes} />
