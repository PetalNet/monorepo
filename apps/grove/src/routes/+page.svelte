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

<main>
	<p class="eyebrow">Effect domain demo</p>
	<h1>Grove sprouts</h1>
	<p class="intro">
		These controls use SvelteKit Remote Functions. The same Effect operations are also exposed as
		<a href="/api/v1/openapi.json">REST/OpenAPI</a> and MCP at <code>/mcp</code>.
	</p>

	<form
		class="plant-form"
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
		<label>
			<span>Sprout name</span>
			<input {...plantForm.fields.name.as("text")} maxlength="80" placeholder="Silver fern" />
			{#each plantForm.fields.name.issues() ?? [] as issue}
				<small class="error">{issue.message}</small>
			{/each}
		</label>
		<button disabled={plantForm.pending > 0}>Plant</button>
	</form>

	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}

	<section aria-label="Sprouts">
		{#each sprouts as sprout (sprout.id)}
			{@const planting = sprout.id.slice("sprout-".length).includes("-")}
			{@const displayedWaterings = watering.value(sprout.id, sprout.waterings)}
			{@const waterForm = waterSprout.for(sprout.id).preflight(WaterSproutValidator)}
			{@const removeForm = removeSprout.for(sprout.id).preflight(SproutIdValidator)}
			<article aria-busy={planting}>
				<div>
					<h2>{sprout.name}</h2>
					<p>
						<code>{planting ? "planting…" : sprout.id}</code> · watered
						<span class="watering-value" aria-live="polite" aria-atomic="true">
							{#key displayedWaterings}<strong>{displayedWaterings}</strong>{/key}×
						</span>
					</p>
				</div>
				<div class="actions">
					<button class="quiet" onclick={() => inspect(sprout.id)}>Inspect</button>
					<form
						class="action-form"
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
							class="water"
							disabled={planting}
							onclick={() =>
								watering.increment(
									sprout.id,
									Math.max(sprout.waterings, inspected?.id === sprout.id ? inspected.waterings : 0),
								)}
						>
							Water
						</button>
					</form>
					<form
						class="action-form"
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
						<button class="danger" disabled={planting}>Remove</button>
					</form>
				</div>
			</article>
		{/each}
	</section>

	{#if displayedInspection}
		<pre>{JSON.stringify(displayedInspection, null, 2)}</pre>
	{/if}
</main>

<style>
	:global(body) {
		margin: 0;
		background: #f1f5ec;
		color: #18351f;
		font-family: ui-sans-serif, system-ui, sans-serif;
	}
	main {
		width: min(760px, calc(100% - 2rem));
		margin: 5rem auto;
	}
	.eyebrow {
		margin: 0;
		color: #52745a;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	h1 {
		margin: 0.25rem 0;
		font-size: clamp(2.5rem, 8vw, 5rem);
		letter-spacing: -0.06em;
	}
	.intro {
		max-width: 620px;
		color: #47634d;
		line-height: 1.6;
	}
	a {
		color: #236d38;
	}
	.plant-form,
	article {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem;
		border: 1px solid #c7d5c3;
		border-radius: 0.8rem;
		background: #fff;
	}
	.plant-form {
		margin: 2rem 0;
	}
	.action-form {
		display: contents;
	}
	label {
		display: grid;
		flex: 1;
		gap: 0.4rem;
		font-size: 0.8rem;
		font-weight: 650;
	}
	input {
		padding: 0.7rem;
		border: 1px solid #aabda6;
		border-radius: 0.4rem;
		font: inherit;
	}
	section {
		display: grid;
		gap: 0.75rem;
	}
	article {
		align-items: center;
	}
	h2,
	article p {
		margin: 0;
	}
	article p {
		margin-top: 0.3rem;
		color: #637966;
		font-size: 0.85rem;
	}
	.watering-value {
		display: inline-flex;
		align-items: baseline;
		min-width: 2.5ch;
		color: #286f3c;
		font-variant-numeric: tabular-nums;
	}
	.watering-value strong {
		display: inline-block;
		animation: count-pop 160ms cubic-bezier(0.2, 1.7, 0.4, 1);
	}
	.actions {
		display: flex;
		gap: 0.4rem;
	}
	button {
		padding: 0.65rem 0.85rem;
		border: 0;
		border-radius: 0.4rem;
		background: #286f3c;
		box-shadow: 0 3px 0 #174d28;
		color: white;
		font: inherit;
		font-weight: 650;
		cursor: pointer;
		touch-action: manipulation;
		transition:
			transform 70ms ease,
			box-shadow 70ms ease,
			background-color 120ms ease;
		user-select: none;
	}
	button:hover:not(:disabled) {
		background: #23733c;
	}
	button:active:not(:disabled) {
		box-shadow: 0 1px 0 #174d28;
		transform: translateY(2px) scale(0.97);
	}
	button:disabled {
		opacity: 0.5;
	}
	button.water {
		min-width: 5.6rem;
	}
	button.quiet {
		background: #e5eee2;
		box-shadow: 0 3px 0 #bacab6;
		color: #284a30;
	}
	button.quiet:active:not(:disabled) {
		box-shadow: 0 1px 0 #bacab6;
	}
	button.danger {
		background: #8b3b35;
		box-shadow: 0 3px 0 #612723;
	}
	button.danger:active:not(:disabled) {
		box-shadow: 0 1px 0 #612723;
	}
	.error {
		color: #8b3b35;
		font-weight: 650;
	}
	pre {
		margin-top: 1rem;
		padding: 1rem;
		overflow: auto;
		border-radius: 0.8rem;
		background: #193320;
		color: #cce4c9;
	}
	@keyframes count-pop {
		0% {
			color: #5aaf6f;
			transform: translateY(0.2rem) scale(0.72);
		}
		100% {
			color: inherit;
			transform: translateY(0) scale(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		button,
		.watering-value strong {
			animation: none;
			transition: none;
		}
	}
	@media (max-width: 620px) {
		main {
			margin: 2rem auto;
		}
		article {
			align-items: start;
			flex-direction: column;
		}
		.actions {
			flex-wrap: wrap;
		}
	}
</style>
