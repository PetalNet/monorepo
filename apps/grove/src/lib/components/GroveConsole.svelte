<script lang="ts">
	import { page } from "$app/state";
	import Library from "@lucide/svelte/icons/library";
	import ListTodo from "@lucide/svelte/icons/list-todo";
	import Plus from "@lucide/svelte/icons/plus";
	import Sprout from "@lucide/svelte/icons/sprout";

	import { openProject } from "#lib/projects.remote.ts";
	import { OpenProjectValidator } from "#lib/projects/forms.ts";

	import AccountMenu from "./AccountMenu.svelte";
	import ConsoleField from "./ConsoleField.svelte";
	import ProjectLibrary from "./ProjectLibrary.svelte";
	import ProjectWork from "./ProjectWork.svelte";

	const openForm = openProject.preflight(OpenProjectValidator);
	let openFailure = $state("");
	const projectId = $derived(page.url.searchParams.get("project") ?? "");
	const library = $derived(page.url.searchParams.get("view") === "library");
	const version = $derived(page.url.searchParams.get("version") ?? "");
	function href(view: string) {
		return `/?${new URLSearchParams({ ...(projectId ? { project: projectId } : {}), ...(version ? { version } : {}), view })}`;
	}
</script>

<div class="bg-base-100 min-h-dvh">
	<aside
		class="bg-base-200 flex items-center justify-between gap-4 p-4 md:fixed md:inset-y-0 md:w-60 md:flex-col md:items-stretch md:justify-start md:p-6"
	>
		<a class="btn btn-ghost justify-start px-2 text-xl font-normal" href="/" aria-label="Grove"
			><Sprout size={24} aria-hidden={true} /><span class="hidden md:inline">Grove</span></a
		>
		<nav aria-label="Console" class="md:mt-8">
			<ul class="menu menu-horizontal md:menu-vertical gap-2 p-0 md:w-full">
				<li>
					<a
						href={href("work")}
						class:menu-active={!library}
						aria-current={!library ? "page" : undefined}
						><ListTodo size={20} aria-hidden={true} />Work</a
					>
				</li>
				<li>
					<a
						href={href("library")}
						class:menu-active={library}
						aria-current={library ? "page" : undefined}
						><Library size={20} aria-hidden={true} />Library</a
					>
				</li>
			</ul>
		</nav>
	</aside>
	<main class="mx-auto max-w-7xl p-4 sm:p-8 md:ms-60 lg:p-12">
		<header class="flex flex-wrap items-center justify-between gap-4">
			<h1 class="text-3xl font-normal">{library ? "Library" : "Work"}</h1>
			<div class="flex items-center gap-2">
				<a class="btn btn-primary" href="/projects/new"
					><Plus size={16} aria-hidden={true} />New project</a
				><AccountMenu />
			</div>
		</header>
		<form
			class="my-8 flex max-w-xl items-end gap-4"
			{...openForm.enhance(async (form) => {
				openFailure = "";

				try {
					await form.submit();
				} catch {
					openFailure = "Could not open this project. Try again.";
				}
			})}
		>
			<input {...openForm.fields.view.as("hidden", library ? "library" : "work")} />
			<div class="min-w-0 grow">
				<ConsoleField
					label="Project ID"
					field={openForm.fields.projectId}
					value={projectId}
					maxlength={256}
				/>
			</div>
			<button class="btn mb-1" disabled={openForm.pending > 0}
				>{openForm.pending > 0 ? "Opening…" : "Open"}</button
			>
		</form>
		{#if openFailure}<p class="text-error mb-4" role="alert">{openFailure}</p>{/if}
		{#if projectId}
			<div class="border-base-300 flex flex-wrap items-center gap-4 border-y py-4 text-sm">
				<span>Project</span><code class="font-mono break-all">{projectId}</code>
			</div>
			{#key projectId}
				{#if library}<ProjectLibrary {projectId} />{:else}<ProjectWork
						{projectId}
						initialVersion={version}
					/>{/if}
			{/key}
		{:else}
			<section class="card bg-base-200 mt-8">
				<div class="card-body gap-2 p-8">
					<h2 class="text-xl font-normal">No project open</h2>
					<p>Enter a project ID or create a project.</p>
				</div>
			</section>
		{/if}
	</main>
</div>
