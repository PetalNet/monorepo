<script lang="ts">
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";
	import { formatRange } from "$lib/dates";
	import type { BreakSource } from "$lib/institutions";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import LogIn from "@lucide/svelte/icons/log-in";
	import Plus from "@lucide/svelte/icons/plus";
	import Trash2 from "@lucide/svelte/icons/trash-2";

	interface BreakRow {
		id: string;
		userId: string;
		label: string;
		startDate: string;
		endDate: string;
		source: BreakSource;
	}

	let {
		meId,
		breaks,
		referenceYear,
		form,
	}: {
		meId: string | null;
		breaks: BreakRow[];
		referenceYear: number;
		form: { error?: string; label?: string; startDate?: string; endDate?: string } | null;
	} = $props();

	/** Common US academic break names, offered as one-tap labels. */
	const PRESETS = ["Fall break", "Thanksgiving", "Winter break", "Spring break", "Summer"];

	// Same predicate the remove action deletes by. Neither an institutional row nor a filled-in
	// default is anybody's to delete, so listing one here would put a button next to it that
	// silently does nothing.
	const mine = $derived(
		breaks
			.filter((b) => b.source === "user" && b.userId === meId)
			.toSorted((a, b) => a.startDate.localeCompare(b.startDate)),
	);

	let label = $state("");
	let startDate = $state("");
	let endDate = $state("");
	let submitting = $state(false);

	// Keep the end date from silently sitting before the start date.
	$effect(() => {
		if (startDate && (!endDate || endDate < startDate)) endDate = startDate;
	});

	const canSubmit = $derived(label.trim().length > 0 && startDate !== "" && endDate !== "");
</script>

<div class="cal-panel editor">
	<h3 class="editor-title">Your breaks</h3>

	{#if !meId}
		<p class="editor-hint">
			Log in to add your own dates. Everyone else's breaks stay visible either way.
		</p>
		<a class="editor-login" href={resolve("/login")}>
			<LogIn size={15} aria-hidden="true" />
			Log in
		</a>
	{:else}
		{#if mine.length === 0}
			<p class="editor-hint">
				You have not added any yet. Add your first break and it shows up on the calendar right away.
			</p>
		{:else}
			<ul class="editor-list">
				{#each mine as b (b.id)}
					<li class="editor-row">
						<span class="editor-names">
							<span class="editor-label">{b.label}</span>
							<span class="editor-range">{formatRange(b.startDate, b.endDate, referenceYear)}</span>
						</span>
						<form method="POST" action="?/remove" use:enhance>
							<input type="hidden" name="id" value={b.id} />
							<button class="editor-del" type="submit" aria-label="Delete {b.label}">
								<Trash2 size={15} aria-hidden="true" />
							</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}

		{#if form?.error}
			<p class="editor-error" role="alert">
				<CircleAlert size={15} aria-hidden="true" />
				{form.error}
			</p>
		{/if}

		<form
			class="editor-form"
			method="POST"
			action="?/add"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
					label = "";
					startDate = "";
					endDate = "";
				};
			}}
		>
			<div class="editor-field">
				<label class="editor-fieldlabel" for="break-label">Name</label>
				<input
					id="break-label"
					name="label"
					type="text"
					maxlength="40"
					placeholder="Winter break"
					bind:value={label}
					required
				/>
			</div>

			<div class="editor-presets">
				{#each PRESETS as preset (preset)}
					<button class="editor-preset" type="button" onclick={() => (label = preset)}>
						{preset}
					</button>
				{/each}
			</div>

			<div class="editor-dates">
				<div class="editor-field">
					<label class="editor-fieldlabel" for="break-start">Starts</label>
					<input
						id="break-start"
						name="startDate"
						type="date"
						bind:value={startDate}
						min="2000-01-01"
						max="2100-12-31"
						required
					/>
				</div>
				<div class="editor-field">
					<label class="editor-fieldlabel" for="break-end">Ends</label>
					<input
						id="break-end"
						name="endDate"
						type="date"
						bind:value={endDate}
						min={startDate || "2000-01-01"}
						max="2100-12-31"
						required
					/>
				</div>
			</div>

			<p class="editor-tip">Both dates count as days off. One day off? Use the same date twice.</p>

			<button class="editor-submit" type="submit" disabled={!canSubmit || submitting}>
				<Plus size={16} aria-hidden="true" />
				{submitting ? "Adding" : "Add break"}
			</button>
		</form>
	{/if}
</div>

<style>
	.editor {
		min-width: 0;
	}

	.editor-title {
		font-size: 1rem;
		font-weight: 700;
		color: var(--cal-ink);
	}

	.editor-hint {
		margin-top: 6px;
		font-size: 0.85rem;
		line-height: 1.55;
		color: var(--cal-ink-2);
	}

	.editor-login {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 12px;
		padding: 9px 14px;
		border-radius: 9px;
		background: var(--cal-accent);
		color: var(--cal-accent-ink);
		font-size: 0.85rem;
		font-weight: 600;
		text-decoration: none;
	}

	.editor-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 10px;
		list-style: none;
	}

	.editor-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 8px 8px 8px 11px;
		border-radius: 9px;
		background: var(--cal-recess);
	}

	.editor-names {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1 1 auto;
	}

	.editor-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--cal-ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.editor-range {
		font-size: 0.76rem;
		color: var(--cal-ink-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.editor-del {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 30px;
		height: 30px;
		border-radius: 8px;
		border: 1px solid transparent;
		background: none;
		color: var(--cal-ink-2);
		cursor: pointer;
		transition:
			background 160ms cubic-bezier(0.22, 1, 0.36, 1),
			color 160ms;
	}

	.editor-del:hover {
		background: var(--cal-surface);
		border-color: var(--cal-border);
		color: var(--cal-ink);
	}

	.editor-error {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 12px;
		padding: 9px 11px;
		border-radius: 9px;
		background: var(--cal-recess);
		border: 1px solid var(--cal-border-strong);
		color: var(--cal-ink);
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.editor-form {
		margin-top: 14px;
		padding-top: 14px;
		border-top: 1px solid var(--cal-border);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.editor-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.editor-fieldlabel {
		font-size: 0.76rem;
		font-weight: 600;
		color: var(--cal-ink-2);
	}

	.editor-form input {
		width: 100%;
		min-width: 0;
		padding: 9px 10px;
		border-radius: 9px;
		border: 1px solid var(--cal-border-strong);
		background: var(--cal-surface);
		color: var(--cal-ink);
		font-size: 0.85rem;
		font-family: inherit;
	}

	.editor-form input::placeholder {
		color: var(--cal-ink-2);
	}

	.editor-form input:focus-visible,
	.editor-preset:focus-visible,
	.editor-submit:focus-visible,
	.editor-del:focus-visible,
	.editor-login:focus-visible {
		outline: none;
		box-shadow: var(--cal-ring);
		border-color: var(--cal-accent);
	}

	.editor-presets {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.editor-preset {
		padding: 5px 9px;
		border-radius: 999px;
		border: 1px solid var(--cal-border-strong);
		background: var(--cal-surface);
		color: var(--cal-ink-2);
		font-size: 0.76rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			background 160ms cubic-bezier(0.22, 1, 0.36, 1),
			color 160ms;
	}

	.editor-preset:hover {
		background: var(--cal-accent-tint);
		color: var(--cal-ink);
	}

	.editor-dates {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 8px;
	}

	.editor-tip {
		font-size: 0.74rem;
		line-height: 1.45;
		color: var(--cal-ink-2);
	}

	.editor-submit {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 10px;
		border-radius: 9px;
		border: none;
		background: var(--cal-accent);
		color: var(--cal-accent-ink);
		font-size: 0.87rem;
		font-weight: 600;
		cursor: pointer;
		transition: filter 160ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.editor-submit:hover:not(:disabled) {
		filter: brightness(1.08);
	}

	.editor-submit:disabled {
		background: var(--cal-border-strong);
		color: var(--cal-ink);
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		.editor-del,
		.editor-preset,
		.editor-submit {
			transition: none;
		}
	}
</style>
