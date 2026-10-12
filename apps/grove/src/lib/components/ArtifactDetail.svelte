<script lang="ts">
	import { page } from "$app/state";

	import { getArtifactVersion } from "#lib/projects.remote.ts";

	let {
		projectId,
		objectId,
		versionId,
		closeHref,
	}: { projectId: string; objectId: string; versionId: string; closeHref: string } = $props();
	const artifact = $derived(getArtifactVersion({ projectId, objectId, versionId }));
	const selected = $derived(
		await artifact.then(
			(value) => value,
			() => artifact.current,
		),
	);
</script>

<article class="card bg-base-200 mt-8 p-8" aria-label="Artifact version">
	<header class="flex items-center justify-between gap-4">
		<h2 class="text-xl font-normal">Artifact</h2>
		<a class="btn btn-ghost" href={closeHref}>Close</a>
	</header>
	{#if artifact.error}<div class="mt-4 flex flex-wrap items-center gap-4">
			<p class="text-error" role="alert">Could not load this artifact version.</p>
			<a
				class="btn btn-ghost"
				href={page.url.href}
				onclick={(event) => {
					event.preventDefault();
					void artifact.refresh().catch(() => undefined);
				}}
				aria-disabled={artifact.loading}>{artifact.loading ? "Loading…" : "Try again"}</a
			>
		</div>{/if}
	{#if selected}
		<pre class="my-8 font-sans break-words whitespace-pre-wrap">{typeof selected.payload.content ===
			"string"
				? selected.payload.content
				: JSON.stringify(selected.payload, null, 2)}</pre>
		<details>
			<summary class="cursor-pointer">Provenance</summary>
			<dl class="mt-4 grid gap-4 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
				<dt>Object</dt>
				<dd class="font-mono break-all">{selected.objectId}</dd>
				<dt>Version</dt>
				<dd class="font-mono break-all">{selected.versionId}</dd>
				<dt>Digest</dt>
				<dd class="font-mono break-all">{selected.digest}</dd>
				<dt>Author</dt>
				<dd class="font-mono break-all">{selected.authorKind}: {selected.authorId}</dd>
				<dt>Review</dt>
				<dd class="break-all">
					<code class="font-mono">{selected.reviewId}</code> · accepted by
					<code class="font-mono">{selected.reviewerId}</code>
				</dd>
			</dl>
		</details>
	{:else if artifact.loading}<p class="my-8" role="status">Loading artifact…</p>{/if}
</article>
