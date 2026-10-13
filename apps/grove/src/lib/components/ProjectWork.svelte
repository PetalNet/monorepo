<script lang="ts">
	import { browser } from "$app/env";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";

	import { readyWork, refreshWork } from "#lib/projects.remote.ts";

	import ActionPanel from "./ActionPanel.svelte";
	import CompleteTaskForm from "./CompleteTaskForm.svelte";
	import PlanTaskForm from "./PlanTaskForm.svelte";
	import ReviewOutputForm from "./ReviewOutputForm.svelte";

	let { projectId, initialVersion = "" }: { projectId: string; initialVersion?: string } = $props();
	const refreshForm = refreshWork;
	let refreshFailure = $state(false);
	const work = $derived(readyWork({ projectId }));
	const tasks = $derived(
		await work.then(
			(value) => value,
			() => work.current,
		),
	);
</script>

<section class="mt-8" aria-labelledby="ready-heading">
	<header class="mb-4 flex items-center justify-between gap-4">
		<h2 id="ready-heading" class="text-xl font-normal">Ready work</h2>
		<form
			{...refreshForm.enhance(async (form) => {
				refreshFailure = false;

				try {
					await form.submit().updates(work);
				} catch {
					refreshFailure = true;
				}
			})}
		>
			<input {...refreshForm.fields.projectId.as("hidden", projectId)} />
			<button class="btn btn-ghost" disabled={refreshForm.pending > 0}
				><RefreshCw size={16} aria-hidden={true} />{refreshForm.pending > 0
					? "Refreshing…"
					: work.error || refreshFailure
						? "Try again"
						: "Refresh"}</button
			>
		</form>
	</header>
	{#if refreshFailure || tasks === undefined || !!work.error}<p
			class="text-error mb-4"
			role="alert"
		>
			{tasks
				? "Could not refresh tasks. Your loaded tasks are still available."
				: "Could not load tasks. Try again."}
		</p>{/if}
	<div aria-busy={browser && work.loading}>
		{#if tasks}
			{#if tasks.length === 0}<div class="card bg-base-200 p-8">All caught up.</div>
			{:else}<ul class="list">
					{#each tasks as task (task.taskId)}
						{@const pending = task.taskId.startsWith("pending-")}
						<li class="list-row border-base-300 border-b px-0 py-6" aria-busy={pending}>
							<div class="list-col-grow min-w-0">
								<h3 class="font-medium">{task.title}</h3>
								{#if pending}<p class="mt-2 text-sm" role="status">Planning…</p>{:else}<details
										class="mt-2 text-sm"
									>
										<summary class="cursor-pointer">References</summary>
										<dl class="mt-2 grid gap-2">
											<dt>Task</dt>
											<dd class="font-mono break-all">{task.taskId}</dd>
											<dt>Version</dt>
											<dd class="font-mono break-all">{task.taskVersionId}</dd>
										</dl>
									</details>{/if}
							</div>
						</li>
					{/each}
				</ul>{/if}
		{:else if work.loading}<p role="status">Loading tasks…</p>{/if}
	</div>
</section>
<section class="mt-8 grid gap-4" aria-label="Task actions">
	<ActionPanel title="Plan a task"><PlanTaskForm {projectId} {initialVersion} {work} /></ActionPanel
	>
	<ActionPanel title="Review an output"><ReviewOutputForm {projectId} {work} /></ActionPanel>
	<ActionPanel title="Complete a task"><CompleteTaskForm {projectId} {work} /></ActionPanel>
</section>
