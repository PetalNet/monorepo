<script lang="ts">
	import type { RemoteQuery } from "$app/server";

	import { reviewOutput } from "#lib/projects.remote.ts";
	import { createCommandSubmission } from "#lib/projects/command-submission.ts";
	import { ReviewOutputValidator } from "#lib/projects/forms.ts";
	import type { ReadyTasks } from "#lib/projects/schema.ts";

	import ConsoleField from "./ConsoleField.svelte";
	import ConsoleMessage from "./ConsoleMessage.svelte";
	let { projectId, work }: { projectId: string; work: RemoteQuery<ReadyTasks> } = $props();
	const form = $derived(reviewOutput.for(projectId).preflight(ReviewOutputValidator));
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
			error = cause instanceof Error ? cause.message : "Could not review the output. Try again.";
		}
	})}
	aria-busy={form.pending > 0}
>
	<input {...form.fields.commandId.as("hidden", command.id)} /><input
		{...form.fields.projectId.as("hidden", projectId)}
	/>
	<p class="text-sm">Use the Agent’s publication receipt. You cannot review your own output.</p>
	<fieldset class="grid gap-4" disabled={form.pending > 0}>
		<ConsoleField label="Task ID" field={form.fields.taskId} /><ConsoleField
			label="Attempt ID"
			field={form.fields.attemptId}
		/>
		<ConsoleField label="Artifact object ID" field={form.fields.objectId} /><ConsoleField
			label="Artifact version ID"
			field={form.fields.versionId}
		/>
		<label class="fieldset"
			><span class="fieldset-legend">Outcome</span><select
				class="select bg-base-300 w-full"
				{...form.fields.outcome.as("select", "accepted")}
				><option value="accepted">Accept</option><option value="rejected">Reject</option></select
			></label
		>
		<ConsoleField
			label="Comments"
			field={form.fields.comments}
			multiline
			required={false}
			maxlength={4000}
		/>
		<button class="btn btn-primary justify-self-start"
			>{form.pending > 0 ? "Reviewing…" : "Submit review"}</button
		>
	</fieldset>
	{#if form.result}<p role="status">
			{form.result.outcome === "accepted"
				? "Output accepted. Complete the task to add it to the Library."
				: "Output rejected."}
		</p>{/if}
</form>
<ConsoleMessage message={error} error dismiss={() => (error = "")} />
