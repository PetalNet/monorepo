<script lang="ts">
	import type { RemoteFormField } from "$app/server";

	let {
		label,
		field,
		value,
		multiline = false,
		maxlength,
		required = true,
	}: {
		label: string;
		field: RemoteFormField<string>;
		value?: string;
		multiline?: boolean;
		maxlength?: number;
		required?: boolean;
	} = $props();
</script>

<label class="fieldset min-w-0">
	<span class="fieldset-legend">{label}</span>
	{#if multiline}
		<textarea
			class="textarea bg-base-300 w-full"
			{...field.as("text", value)}
			{required}
			{maxlength}
			rows="4"></textarea>
	{:else}
		<input
			class="input bg-base-300 h-11 w-full"
			{...field.as("text", value)}
			{required}
			{maxlength}
		/>
	{/if}
	{#each field.issues() ?? [] as issue, index (index)}
		<span class="text-error text-sm">{issue.message}</span>
	{/each}
</label>
