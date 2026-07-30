<script lang="ts">
	import { OptimisticCounter } from "$lib/optimistic-counter.svelte";
	import {
		createSprout,
		getSprout,
		listSprouts,
		removeSprout,
		waterSprout,
	} from "$lib/sprouts.remote";
	import {
		Counter,
		CreateSproutValidator,
		SproutIdValidator,
		WaterSproutValidator,
		type Sprout,
		type SproutIdValue,
	} from "$lib/sprouts/schema";

	const sproutsQuery = listSprouts();
	const plantForm = createSprout.preflight(CreateSproutValidator);
	const sprouts = $derived(await sproutsQuery);
	let inspectedId = $state<string | null>(null);
	let inspectedQuery = $state<ReturnType<typeof getSprout> | null>(null);
	let error = $state("");
	const inspected = $derived(inspectedQuery ? await inspectedQuery : null);
	const watering = new OptimisticCounter<readonly Sprout[]>({
		withOverride: (update) => sproutsQuery.withOverride(update),
		update: (current, id, value) =>
			current.map((sprout) =>
				sprout.id === id ? { ...sprout, waterings: Counter.make(value) } : sprout,
			),
		onStart: () => (error = ""),
		onError: (cause) =>
			(error = cause instanceof Error ? cause.message : "Could not water the sprout."),
		failureMessage: "Could not water the sprout.",
	});
	const displayedInspection = $derived(
		inspected
			? { ...inspected, waterings: watering.value(inspected.id, inspected.waterings) }
			: null,
	);

	function inspect(id: SproutIdValue) {
		inspectedId = id;
		inspectedQuery = getSprout({ id });
	}
</script>

<svelte:head><title>Grove transport demo</title></svelte:head>

<main class="mx-auto min-h-screen w-full max-w-3xl px-4 py-12 sm:py-20">
	<p class="text-primary text-xs font-bold tracking-[0.12em] uppercase">Effect domain demo</p>
	<h1 class="mt-1 text-5xl font-bold tracking-tight sm:text-7xl">Grove sprouts</h1>
	<p class="text-base-content/70 mt-4 max-w-2xl leading-relaxed">
		These controls use SvelteKit Remote Functions. The same Effect operations are also exposed as
		<a class="link link-primary" href="/api/v1/openapi.json">REST/OpenAPI</a> and MCP at
		<code class="bg-base-300 rounded px-1.5 py-0.5">/mcp</code>.
	</p>

	<form
		class="border-base-300 bg-base-100 rounded-box my-8 flex items-end gap-4 border p-4 shadow-sm"
		{...plantForm.enhance(async (form) => {
			const plantedName = form.fields.name.value()?.trim() ?? "";
			const optimisticSprout: Sprout = {
				id: `sprout-${crypto.randomUUID()}`,
				name: plantedName,
				plantedAt: new Date().toISOString(),
				waterings: Counter.make(0),
			};

			error = "";
			try {
				if (
					await form
						.submit()
						.updates(sproutsQuery.withOverride((current) => [...current, optimisticSprout]))
				) {
					form.element.reset();
				}
			} catch (cause) {
				error = cause instanceof Error ? cause.message : "Could not plant the sprout.";
			}
		})}
	>
		<label class="fieldset min-w-0 grow">
			<span class="fieldset-legend">Sprout name</span>
			<input
				class="input w-full"
				{...plantForm.fields.name.as("text")}
				maxlength="80"
				placeholder="Silver fern"
			/>
			{#each plantForm.fields.name.issues() ?? [] as issue, index (index)}
				<small class="text-error font-semibold">{issue.message}</small>
			{/each}
		</label>
		<button class="btn btn-primary" disabled={plantForm.pending > 0}>Plant</button>
	</form>

	{#if error}
		<div class="alert alert-error mb-4" role="alert">{error}</div>
	{/if}

	<section class="grid gap-3" aria-label="Sprouts">
		{#each sprouts as sprout (sprout.id)}
			{@const planting = sprout.id.slice("sprout-".length).includes("-")}
			{@const displayedWaterings = watering.value(sprout.id, sprout.waterings)}
			{@const waterForm = waterSprout.for(sprout.id).preflight(WaterSproutValidator)}
			{@const removeForm = removeSprout.for(sprout.id).preflight(SproutIdValidator)}
			<article
				class="border-base-300 bg-base-100 rounded-box flex items-center justify-between gap-4 border p-4 shadow-sm max-sm:flex-col max-sm:items-start"
				aria-busy={planting}
			>
				<div>
					<h2 class="text-lg font-semibold">{sprout.name}</h2>
					<p class="text-base-content/60 mt-1 text-sm">
						<code class="bg-base-300 rounded px-1.5 py-0.5"
							>{planting ? "planting…" : sprout.id}</code
						>
						· watered
						<span
							class="text-success inline-flex min-w-[2.5ch] items-baseline tabular-nums"
							aria-live="polite"
							aria-atomic="true"
						>
							{#key displayedWaterings}<strong>{displayedWaterings}</strong>{/key}×
						</span>
					</p>
				</div>
				<div class="flex flex-wrap gap-2">
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => {
							inspect(sprout.id);
						}}>Inspect</button
					>
					<form
						class="contents"
						{...waterForm.enhance(async (form) => {
							await watering.submit(sprout.id, () =>
								form
									.submit()
									.updates(
										sproutsQuery,
										...(inspectedId === sprout.id && inspectedQuery ? [inspectedQuery] : []),
									),
							);
						})}
					>
						<input {...waterForm.fields.id.as("hidden", sprout.id)} />
						<button
							class="btn btn-primary btn-sm min-w-20"
							disabled={planting}
							onclick={() => {
								watering.increment(
									sprout.id,
									Math.max(sprout.waterings, inspected?.id === sprout.id ? inspected.waterings : 0),
								);
							}}
						>
							Water
						</button>
					</form>
					<form
						class="contents"
						{...removeForm.enhance(async (form) => {
							error = "";
							try {
								if (
									await watering.after(sprout.id, () =>
										form
											.submit()
											.updates(
												sproutsQuery.withOverride((current) =>
													current.filter((currentSprout) => currentSprout.id !== sprout.id),
												),
											),
									)
								) {
									if (inspectedId === sprout.id) {
										inspectedId = null;
										inspectedQuery = null;
									}
								}
							} catch (cause) {
								error = cause instanceof Error ? cause.message : "Could not remove the sprout.";
							}
						})}
					>
						<input {...removeForm.fields.id.as("hidden", sprout.id)} />
						<button class="btn btn-error btn-sm" disabled={planting}>Remove</button>
					</form>
				</div>
			</article>
		{/each}
	</section>

	{#if displayedInspection}
		<pre class="bg-neutral text-neutral-content rounded-box mt-4 overflow-auto p-4">{JSON.stringify(
				displayedInspection,
				null,
				2,
			)}</pre>
	{/if}
</main>

<style>
	strong {
		display: inline-block;
		animation: count-pop 160ms cubic-bezier(0.2, 1.7, 0.4, 1);
	}
	@keyframes count-pop {
		0% {
			color: var(--color-success);
			transform: translateY(0.2rem) scale(0.72);
		}
		100% {
			color: inherit;
			transform: translateY(0) scale(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		strong {
			animation: none;
		}
	}
</style>
