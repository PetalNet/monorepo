<script lang="ts">
	import { refreshAll } from "$app/navigation";
	import { resolve } from "$app/paths";
	import { Mic, Download } from "@lucide/svelte";

	import type { Decision } from "#lib/server/store.ts";

	import type { PageData } from "./$types";
	let { data }: { data: PageData } = $props();
	let pageSize = $state(50);
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
</script>

<svelte:head><title>Review voices · Hey Janet</title></svelte:head>
<main class="shell admin">
	<header class="topbar">
		<a class="brand" href={resolve("/")}><Mic size={20} /> Hey Janet</a>
		<form method="POST" action={resolve("/auth/logout")}>
			<button class="text-button">Sign out</button>
		</form>
	</header>
	<section class="intro">
		<h1>Listen. Choose.<br />Teach Janet.</h1>
		<p>
			{participants.length} participants · {data.clips.length} takes · {data.clips.filter(
				(c) => c.decision === "keep",
			).length} kept
		</p>
		<p class="muted">
			Keep the voices you want in the training set. Dropped takes stay in the archive.
		</p>
	</section>
	<a class="button" href={resolve("/api/admin/export")} download
		><Download size={20} />Export kept set</a
	>
	<div class="filters">
		<div>
			<label for="person">Participant</label><select
				id="person"
				bind:value={person}
				onchange={reset}
				><option value="all">All participants</option>{#each participants as p (p.id)}<option
						value={p.id}>{p.name} · {p.id.slice(0, 8)}</option
					>{/each}</select
			>
		</div>
		<div>
			<label for="kind">Phrase</label><select id="kind" bind:value={kind} onchange={reset}
				><option value="all">All phrases</option><option value="pos">Wake phrase</option><option
					value="neg">Near miss</option
				></select
			>
		</div>
		<div>
			<label for="device">Device</label><select id="device" bind:value={device} onchange={reset}
				><option value="all">All devices</option><option value="phone">Phone</option><option
					value="tablet">Tablet</option
				><option value="desktop">Desktop</option><option value="unknown">Unknown</option></select
			>
		</div>
		<div>
			<label for="status">Review</label><select id="status" bind:value={status} onchange={reset}
				><option value="undecided">Unreviewed</option><option value="keep">Kept</option><option
					value="drop">Dropped</option
				><option value="all">All takes</option></select
			>
		</div>
	</div>
	<div class="row">
		<button
			class="secondary"
			onclick={() => {
				selected = shown.map((c) => c.clipId);
			}}>Select visible ({shown.length})</button
		><button
			disabled={busy || !selected.length}
			onclick={() => {
				void decide("keep");
			}}>Keep selected</button
		><button
			class="secondary"
			disabled={busy || !selected.length}
			onclick={() => {
				void decide("drop");
			}}>Drop selected</button
		><button
			class="text-button"
			disabled={busy || !selected.length}
			onclick={() => {
				void decide("undecided");
			}}>Reset selected</button
		>
	</div>
	<p role="status">{message || `${String(selected.length)} selected`}</p>
	<ul class="review-list">
		{#each shown as clip (clip.clipId)}<li>
				<label class="review-label"
					><input type="checkbox" bind:group={selected} value={clip.clipId} /><span
						>{clip.name} · “{clip.say}”<br /><small>{clip.how}</small></span
					></label
				>
				<p class="muted">
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
				<div class="row">
					<button
						disabled={busy}
						onclick={() => {
							void decide("keep", [clip.clipId]);
						}}>Keep</button
					><button
						disabled={busy}
						class="secondary"
						onclick={() => {
							void decide("drop", [clip.clipId]);
						}}>Drop</button
					><button
						disabled={busy}
						class="text-button"
						onclick={() => {
							void decide("undecided", [clip.clipId]);
						}}>Reset</button
					>
				</div>
			</li>{:else}<li>All caught up.</li>{/each}
	</ul>
	{#if shown.length < visible.length}<button
			class="secondary"
			onclick={() => {
				pageSize += 50;
			}}>Show 50 more</button
		>{/if}
</main>
