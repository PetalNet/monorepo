<script lang="ts">
	import type { RemoteQuery } from "$app/server";

	import { completeTask } from "#lib/projects.remote.ts";
	import { createCommandSubmission } from "#lib/projects/command-submission.ts";
	import { CompleteTaskValidator } from "#lib/projects/forms.ts";
	import type { ReadyTasks } from "#lib/projects/schema.ts";

	import ConsoleField from "./ConsoleField.svelte";
	import ConsoleMessage from "./ConsoleMessage.svelte";
	let { projectId, work }: { projectId: string; work: RemoteQuery<ReadyTasks> } = $props();
	const form = $derived(completeTask.for(projectId).preflight(CompleteTaskValidator));
	const command = createCommandSubmission();
	let error = $state("");
</script>

<form
	class="grid gap-4"
	{@attach command.attach(form.fields.commandId.as("hidden", command.id).name)}
	{...form.enhance(async ({ submit }) => {
		error = "";

		try {
			if (await submit().updates(work)) {
				command.complete();
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not complete the task. Try again.";
		}
	})}
	aria-busy={form.pending > 0}
>
	<input {...form.fields.commandId.as("hidden", command.id)} /><input
		{...form.fields.projectId.as("hidden", projectId)}
	/>
	<p class="text-sm">Requires an accepted output and the task version ID from before execution.</p>
	<fieldset class="grid gap-4" disabled={form.pending > 0}>
		<ConsoleField label="Task ID" field={form.fields.taskId} />
		<ConsoleField label="Expected task version ID" field={form.fields.expectedVersionId} />
		<button class="btn btn-primary justify-self-start"
			>{form.pending > 0 ? "Completing…" : "Complete task"}</button
		>
	</fieldset>
	{#if form.result}<p role="status">Task completed.</p>{/if}
</form>
<ConsoleMessage message={error} error dismiss={() => (error = "")} />
