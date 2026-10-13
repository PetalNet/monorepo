<script lang="ts">
	import { goto } from "$app/navigation";
	import type { RemoteQuery } from "$app/server";
	import { page } from "$app/state";

	import { planTask } from "#lib/projects.remote.ts";
	import { createCommandSubmission } from "#lib/projects/command-submission.ts";
	import { PlanTaskValidator } from "#lib/projects/forms.ts";
	import type { ReadyTasks } from "#lib/projects/schema.ts";

	import ConsoleField from "./ConsoleField.svelte";
	import ConsoleMessage from "./ConsoleMessage.svelte";

	let {
		projectId,
		initialVersion,
		work,
	}: { projectId: string; initialVersion: string; work: RemoteQuery<ReadyTasks> } = $props();
	const form = $derived(planTask.for(projectId).preflight(PlanTaskValidator));
	const command = createCommandSubmission();
	let error = $state("");
	const version = $derived(form.result?.versionId ?? initialVersion);
</script>

<form
	class="grid gap-4"
	{@attach command.attach(form.fields.commandId.as("hidden", command.id).name)}
	{...form.enhance(async ({ submit, fields, element }) => {
		error = "";
		const title = fields.title.value() ?? "";

		try {
			if (
				await submit().updates(
					work.withOverride((current) => [
						...current,
						{ taskId: `pending-${command.id}`, taskVersionId: "", title, dependencyTaskIds: [] },
					]),
				)
			) {
				element.reset();
				command.complete();

				if (form.result && page.url.searchParams.get("project") === projectId) {
					const url = new URL(page.url.href);

					url.searchParams.set("version", form.result.versionId);
					await goto(url, { shallow: true, replace: true, state: page.state });
				}
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not plan the task. Try again.";
		}
	})}
	aria-busy={form.pending > 0}
>
	<input {...form.fields.commandId.as("hidden", command.id)} /><input
		{...form.fields.projectId.as("hidden", projectId)}
	/>
	<p class="text-sm">Use the version ID from the latest project receipt.</p>
	<fieldset class="grid gap-4" disabled={form.pending > 0}>
		<ConsoleField
			label="Project version ID"
			field={form.fields.expectedVersionId}
			value={version}
		/>
		<ConsoleField label="Task title" field={form.fields.title} maxlength={256} />
		<ConsoleField label="Objective" field={form.fields.objective} multiline maxlength={4000} />
		<button class="btn btn-primary justify-self-start"
			>{form.pending > 0 ? "Planning…" : "Plan task"}</button
		>
	</fieldset>
	{#if form.result}<p role="status">Task planned.</p>{/if}
</form>
<ConsoleMessage message={error} error dismiss={() => (error = "")} />
