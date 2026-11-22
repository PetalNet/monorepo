<script lang="ts">
	import { type CreatureModelId, creatureModels, creatureModelIds } from "../creatures";
	let { value = $bindable<CreatureModelId | null>(null) } = $props();
	const id = $props.id();
</script>

<div class="field">
	<label for={id}>3D creature</label><select
		{id}
		aria-describedby={`${id}-hint`}
		class="select"
		value={value ?? ""}
		onchange={(event) => {
			value = creatureModelIds.find((id) => id === event.currentTarget.value) ?? null;
		}}
		><option value="">Photo only</option
		>{#each Object.entries(creatureModels) as [id, model] (id)}<option value={id}
				>{model.label}</option
			>{/each}</select
	><small id={`${id}-hint`} class="muted">The real photo stays a tap away.</small>
</div>
