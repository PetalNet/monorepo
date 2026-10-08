<script lang="ts">
	import { refreshAll } from "$app/navigation";
	import { resolve } from "$app/paths";
	import { Mic, Download } from "@lucide/svelte";
	import { onMount } from "svelte";

	import type { Decision } from "#lib/server/store.ts";

	import type { PageData } from "./$types";
	let { data }: { data: PageData } = $props();
	let pageSize = $state(50);
	let loaded = $state(false);
	onMount(() => {
		loaded = true;
	});
	let deleteDialog = $state<HTMLDialogElement>();
	let kind = $state("all"),
		device = $state("all"),
		status = $state("undecided"),
		person = $state("all"),
		selected = $state<string[]>([]),
		message = $state(""),
		busy = $state(false);
	const participants = $derived(Array.from(new Map(data.clips.map((c) => [c.id, c])).values()));
	const visible = $derived(
		data.clips.filter(
			(c) =>
				(kind === "all" || c.kind === kind) &&
				(device === "all" || c.deviceType === device) &&
				(status === "all" || c.decision === status) &&
				(person === "all" || c.id === person),
		),
	);
	const shown = $derived(visible.slice(0, pageSize));
	function reset() {
		pageSize = 50;
		selected = [];
	}
	async function decide(decision: Decision, ids = selected) {
		if (!ids.length) return;
		busy = true;
		message = "";
		try {
			const response = await fetch("/api/admin/review", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ids, decision }),
			});
			if (!response.ok) throw new Error("Review could not be saved. Sign in again or retry.");
			selected = [];
			await refreshAll();
			message = "Review saved. Audio is preserved.";
		} catch (e) {
			message = e instanceof Error ? e.message : "Could not save review.";
		} finally {
			busy = false;
		}
	}
	async function removeParticipant() {
		if (person === "all" || busy) return;
		busy = true;
		try {
			const response = await fetch(resolve("/api/admin/participants/[id]", { id: person }), {
				method: "DELETE",
			});
			if (!response.ok) throw new Error("Could not delete this participant. Try again.");
			person = "all";
			reset();
			await refreshAll();
			deleteDialog?.close();
			message = "Participant recordings deleted.";
		} catch (e) {
			deleteDialog?.close();
			message = e instanceof Error ? e.message : "Deletion failed.";
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Review voices · Hey Janet</title></svelte:head>
<main class="mx-auto max-w-5xl p-4 sm:p-6">
	<header class="border-base-300 flex items-center justify-between gap-4 border-b pt-2 pb-6">
		<a
			class="text-base-content flex items-center gap-2 font-semibold no-underline"
			href={resolve("/")}><Mic size={20} /> Hey Janet</a
		>
		<form method="POST" action={resolve("/auth/logout")}>
			<button class="btn btn-ghost text-primary min-h-12 border-0 shadow-none">Sign out</button>
		</form>
	</header>
	<section class="max-w-xl pt-8 pb-6">
		<h1>Listen. Choose.<br />Teach Janet.</h1>
		<p>
			{participants.length} participants · {data.clips.length} takes · {data.clips.filter(
				(c) => c.decision === "keep",
			).length} kept
		</p>
		<p class="text-base-content">
			Keep the voices you want in the training set. Dropped takes stay in the archive.
		</p>
	</section>
	<a
		class="btn btn-primary min-h-12 border-0 shadow-none"
		href={resolve("/api/admin/export")}
		download><Download size={20} />Export wake-word set</a
	>
	<a
		class="btn bg-base-100 text-base-content min-h-12 border-0 shadow-none"
		href={`${resolve("/api/admin/export")}?set=speaker`}
		download><Download size={20} />Export speaker-ID set</a
	>
	<fieldset disabled={!loaded}>
		<div class="my-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<div>
				<label class="block" for="person">Participant</label><select
					class="select bg-base-100 min-h-12 w-full border-0"
					id="person"
					bind:value={person}
					onchange={reset}
					><option value="all">All participants</option>{#each participants as p (p.id)}<option
							value={p.id}>{p.name} · {p.id.slice(0, 8)}</option
						>{/each}</select
				>
			</div>
			<div>
				<label for="kind">Kind</label><select
					class="select bg-base-100 min-h-12 w-full border-0"
					id="kind"
					bind:value={kind}
					onchange={reset}
					><option value="all">All recordings</option><option value="pos">Wake phrase</option
					><option value="neg">Near miss</option><option value="enroll"
						>Voice profile sentence</option
					><option value="free">Free speech</option></select
				>
			</div>
			<div>
				<label class="block" for="device">Device</label><select
					class="select bg-base-100 min-h-12 w-full border-0"
					id="device"
					bind:value={device}
					onchange={reset}
					><option value="all">All devices</option><option value="phone">Phone</option><option
						value="tablet">Tablet</option
					><option value="desktop">Desktop</option></select
				>
			</div>
			<div>
				<label class="block" for="status">Review</label><select
					class="select bg-base-100 min-h-12 w-full border-0"
					id="status"
					bind:value={status}
					onchange={reset}
					><option value="undecided">Unreviewed</option><option value="keep">Kept</option><option
						value="drop">Dropped</option
					><option value="all">All takes</option></select
				>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-4">
			<button
				class="btn bg-base-100 text-base-content min-h-12 border-0 shadow-none"
				onclick={() => {
					selected = shown.map((c) => c.clipId);
				}}>Select visible ({shown.length})</button
			><button
				class="btn btn-primary min-h-12 border-0 shadow-none"
				disabled={busy || !selected.length}
				onclick={() => {
					void decide("keep");
				}}>Keep selected</button
			><button
				class="btn bg-base-100 text-base-content min-h-12 border-0 shadow-none"
				disabled={busy || !selected.length}
				onclick={() => {
					void decide("drop");
				}}>Drop selected</button
			><button
				class="btn btn-ghost text-primary min-h-12 border-0 shadow-none"
				disabled={busy || !selected.length}
				onclick={() => {
					void decide("undecided");
				}}>Reset selected</button
			>
		</div>
		<button
			class="btn btn-ghost text-primary min-h-12 border-0 shadow-none"
			disabled={busy || person === "all"}
			onclick={() => {
				deleteDialog?.showModal();
			}}>Delete participant</button
		>
		<dialog class="modal" bind:this={deleteDialog} aria-labelledby="delete-title">
			<div class="modal-box">
				<h2 id="delete-title">
					Delete {participants.find((p) => p.id === person)?.name}'s recordings?
				</h2>
				<p>
					This permanently removes their audio and clip metadata. Queued uploads from this
					participant will be rejected.
				</p>
				<div class="modal-action">
					<form method="dialog"><button class="btn" disabled={busy}>Cancel</button></form>
					<button
						class="btn btn-primary"
						disabled={busy}
						onclick={() => {
							void removeParticipant();
						}}>Delete recordings</button
					>
				</div>
			</div>
		</dialog>
		<p role="status">{message || `${String(selected.length)} selected`}</p>
		<ul class="divide-base-300 list-none divide-y p-0">
			{#each shown as clip (clip.clipId)}<li class="py-6">
					<label class="flex items-center gap-4"
						><input
							class="checkbox checkbox-primary shrink-0"
							type="checkbox"
							bind:group={selected}
							value={clip.clipId}
						/><span>{clip.name} · “{clip.say}”<br /><small>{clip.how}</small></span></label
					>
					<p class="text-base-content">
						{clip.deviceType} · {clip.duration.toFixed(1)} s · {clip.decision}{clip.flags.length
							? ` · ${clip.flags.join(", ")}`
							: ""}
					</p>
					<audio
						controls
						preload="none"
						src={resolve("/api/admin/audio/[id]", { id: clip.clipId })}
						aria-label={`Play ${clip.name}: ${clip.say}`}
					></audio>
					<div class="flex flex-wrap items-center gap-4">
						<button
							class="btn btn-primary min-h-12 border-0 shadow-none"
							disabled={busy}
							onclick={() => {
								void decide("keep", [clip.clipId]);
							}}>Keep</button
						><button
							disabled={busy}
							class="btn bg-base-100 text-base-content min-h-12 border-0 shadow-none"
							onclick={() => {
								void decide("drop", [clip.clipId]);
							}}>Drop</button
						><button
							disabled={busy}
							class="btn btn-ghost text-primary min-h-12 border-0 shadow-none"
							onclick={() => {
								void decide("undecided", [clip.clipId]);
							}}>Reset</button
						>
					</div>
				</li>{:else}<li>All caught up.</li>{/each}
		</ul>
		{#if shown.length < visible.length}<button
				class="btn bg-base-100 text-base-content min-h-12 border-0 shadow-none"
				onclick={() => {
					pageSize += 50;
				}}>Show 50 more</button
			>{/if}
	</fieldset>
</main>
