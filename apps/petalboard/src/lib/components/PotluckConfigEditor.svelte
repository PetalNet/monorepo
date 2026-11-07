<script lang="ts">
	import { slugifyCategory, type PotluckConfig } from "$lib/potluck";
	import { untrack } from "svelte";

	let { initial, errors = [] }: { initial: PotluckConfig; errors?: string[] } = $props();

	interface Row {
		id: string | null;
		label: string;
		ratio: number;
		ideas: string;
		forceOpen: boolean;
	}

	// The editor owns its draft once mounted; later prop changes must not clobber typing.
	const start = untrack(() => initial);
	let providing = $state(start.providing);
	let minOptions = $state(start.minOptions);
	let rows = $state<Row[]>(start.categories.map((c) => ({ ...c, ideas: c.ideas.join(", ") })));

	const ratioTotal = $derived(rows.reduce((sum, r) => sum + (Number(r.ratio) || 0), 0));

	const serialized = $derived.by(() => {
		const used = new Set<string>();
		const categories = rows.map((r) => {
			let id = r.id ?? slugifyCategory(r.label);

			for (let n = 2; used.has(id); n++) {
				id = `${slugifyCategory(r.label)}-${n}`;
			}

			used.add(id);

			return {
				id,
				label: r.label,
				ratio: Number(r.ratio),
				ideas: r.ideas
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				forceOpen: r.forceOpen,
			};
		});

		return JSON.stringify({ providing, minOptions: Number(minOptions), categories });
	});
</script>

<div class="space-y-4">
	<input type="hidden" name="potluckConfig" value={serialized} />

	<label class="form-label">
		<span>Hosts are providing</span>
		<input class="input-field" maxlength="200" bind:value={providing} />
		<small class="text-sm text-gray-600">Shown to guests so nobody brings the same thing</small>
	</label>

	<div class="space-y-3">
		<div class="flex items-baseline justify-between gap-3">
			<span class="font-semibold text-dark-900">Dish categories</span>
			<small class="text-sm {ratioTotal === 100 ? 'text-gray-600' : 'text-orange-700'}"
				>Shares total {ratioTotal}%</small
			>
		</div>
		{#each rows as row, i}
			<div class="space-y-2 rounded-xl border border-primary-700/15 p-3">
				<div class="flex flex-wrap items-end gap-2">
					<label class="form-label min-w-[10rem] flex-1">
						<span class="text-sm">Category</span>
						<input class="input-field" required maxlength="40" bind:value={row.label} />
					</label>
					<label class="form-label w-24">
						<span class="text-sm">Share %</span>
						<input
							class="input-field"
							type="number"
							min="1"
							max="100"
							required
							bind:value={row.ratio}
						/>
					</label>
					<button
						type="button"
						class="btn-secondary px-3"
						aria-label="Remove {row.label || 'category'}"
						onclick={() => rows.splice(i, 1)}
						disabled={rows.length <= 2}>✕</button
					>
				</div>
				<label class="form-label">
					<span class="text-sm">Ideas for guests (comma separated, optional)</span>
					<textarea class="input-field" rows="2" bind:value={row.ideas}></textarea>
				</label>
			</div>
		{/each}
		<button
			type="button"
			class="btn-secondary"
			onclick={() => rows.push({ id: null, label: "", ratio: 10, ideas: "", forceOpen: false })}
			>+ Add category</button
		>
	</div>

	<label class="form-label">
		<span>Always offer at least</span>
		<input
			class="input-field w-24"
			type="number"
			min="1"
			max={rows.length}
			bind:value={minOptions}
		/>
		<small class="text-sm text-gray-600"
			>Categories a guest can pick from, even when the mix is off target</small
		>
	</label>

	{#each errors as message}
		<small class="block text-sm text-red-600">{message}</small>
	{/each}
</div>
