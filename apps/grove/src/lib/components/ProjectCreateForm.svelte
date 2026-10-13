<script lang="ts">
	import { createProject } from "#lib/projects.remote.ts";
	import { createCommandSubmission } from "#lib/projects/command-submission.ts";
	import { CreateProjectValidator } from "#lib/projects/forms.ts";

	import ConsoleField from "./ConsoleField.svelte";
	import ConsoleMessage from "./ConsoleMessage.svelte";

	const form = createProject.preflight(CreateProjectValidator);
	const command = createCommandSubmission();
	let error = $state("");
</script>

<form
	class="grid gap-4"
	{@attach command.attach(form.fields.commandId.as("hidden", command.id).name)}
	{...form.enhance(async ({ submit }) => {
		error = "";

		try {
			if (await submit()) {
				command.complete();
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not create the project. Try again.";
		}
	})}
	aria-busy={form.pending > 0}
>
	<input {...form.fields.commandId.as("hidden", command.id)} />
	<fieldset class="grid gap-4" disabled={form.pending > 0}>
		<ConsoleField label="Project title" field={form.fields.title} maxlength={256} />
		<ConsoleField label="Scope" field={form.fields.scope} maxlength={128} />
		<ConsoleField
			label="What should get done?"
			field={form.fields.ask}
			multiline
			maxlength={4000}
		/>
		<div class="flex gap-4">
			<button class="btn btn-primary">{form.pending > 0 ? "Creating…" : "Create project"}</button><a
				class="btn btn-ghost"
				href="/">Cancel</a
			>
		</div>
	</fieldset>
</form>
<ConsoleMessage message={error} error dismiss={() => (error = "")} />
