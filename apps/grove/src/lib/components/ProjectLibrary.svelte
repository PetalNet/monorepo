<script lang="ts">
	import { browser } from "$app/env";
	import { page } from "$app/state";

	import { findArtifacts, searchLibrary } from "#lib/projects.remote.ts";
	import { FindArtifactsValidator } from "#lib/projects/forms.ts";

	import ArtifactDetail from "./ArtifactDetail.svelte";
	import ConsoleField from "./ConsoleField.svelte";
	let { projectId }: { projectId: string } = $props();
	const searchForm = findArtifacts.preflight(FindArtifactsValidator);
	let searchFailure = $state(false);
	const search = $derived((page.url.searchParams.get("query") ?? "").trim());
	const results = $derived(search ? searchLibrary({ projectId, query: search, limit: 20 }) : null);
	const artifacts = $derived(
		results
			? await results.then(
					(value) => value,
					() => undefined,
				)
			: undefined,
	);
	const objectId = $derived(page.url.searchParams.get("artifact") ?? "");
	const versionId = $derived(page.url.searchParams.get("artifactVersion") ?? "");
	function href(artifact?: string, artifactVersion?: string) {
		return `/?${new URLSearchParams({ project: projectId, view: "library", query: search, ...(artifact && artifactVersion ? { artifact, artifactVersion } : {}) })}`;
	}
</script>

<section class="mt-8" aria-label="Artifact search">
	<form
		class="mb-8 flex items-end gap-4"
		{...searchForm.enhance(async (form) => {
			searchFailure = false;

			try {
				if (results && form.fields.query.value()?.trim() === search) {
					await results.refresh();
				} else {
					await form.submit();
				}
			} catch {
				searchFailure = true;
			}
		})}
	>
		<input {...searchForm.fields.projectId.as("hidden", projectId)} />
		<div class="min-w-0 grow">
			<ConsoleField
				label="Search artifacts"
				field={searchForm.fields.query}
				value={search}
				maxlength={256}
				required={false}
			/>
		</div>
		<button class="btn btn-primary mb-1" disabled={searchForm.pending > 0}>Search</button>
	</form>
	{#if searchFailure || (results && (artifacts === undefined || !!results.error))}<p
			class="text-error mb-4"
			role="alert"
		>
			Could not search for “{search}”. Submit your search again.
		</p>{/if}
	{#if browser && results?.loading}<p class="mb-4" role="status">Searching for “{search}”…</p>{/if}
	{#if artifacts}
		{#if artifacts.length === 0}<p class="card bg-base-200 p-8">
				No artifacts matching “{search}”.
			</p>
		{:else}<ul class="list">
				{#each artifacts as artifact (artifact.versionId)}
					<li class="list-row border-base-300 border-b px-0 py-6">
						<div class="list-col-grow min-w-0">
							<h2 class="font-medium">
								<a class="link" href={href(artifact.objectId, artifact.versionId)}
									>{artifact.title}</a
								>
							</h2>
							<p class="mt-2 line-clamp-3 break-words">{artifact.content}</p>
						</div>
					</li>
				{/each}
			</ul>{/if}
	{/if}
	{#if objectId && versionId}<ArtifactDetail
			{projectId}
			{objectId}
			{versionId}
			closeHref={href()}
		/>{/if}
</section>
