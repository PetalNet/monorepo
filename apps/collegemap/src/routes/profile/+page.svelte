<script lang="ts">
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";
	import CollegeSearch from "$lib/components/CollegeSearch.svelte";
	import {
		INSTITUTION_KIND_HINTS,
		INSTITUTION_KIND_LABELS,
		INSTITUTION_KINDS,
		type InstitutionKind,
	} from "$lib/institutions";

	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();

	interface SelectedInstitution {
		name: string;
		latitude: number;
		longitude: number;
		isCustom: boolean;
	}

	let kind = $state<InstitutionKind>(data.currentCollege?.kind ?? "college");
	let selectedInstitution = $state<SelectedInstitution | null>(null);

	function selectKind(next: InstitutionKind) {
		kind = next;
		// A base picked while the kind said "college" would be filed as a college and given an
		// academic calendar. Changing the kind therefore throws the choice away rather than
		// re-labelling it.
		selectedInstitution = null;
	}

	function handleInstitutionSelect(institution: SelectedInstitution) {
		selectedInstitution = institution;
	}
</script>

<svelte:head>
	<title>Profile - College Map</title>
</svelte:head>

<div class="profile-page">
	<div class="profile-container">
		<div class="profile-card">
			<div class="profile-header">
				<div class="profile-avatar">
					{data.user.firstName[0]}{data.user.lastName[0]}
				</div>
				<h1 class="profile-name">{data.user.firstName} {data.user.lastName}</h1>
			</div>

			{#if form?.success}
				<div class="msg-success">Saved.</div>
			{/if}

			{#if form?.error}
				<div class="msg-error">{form.error}</div>
			{/if}

			<div class="current-college">
				<h2 class="section-label">Where you are</h2>
				{#if data.currentCollege}
					<div class="college-badge">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<path d="M12 2L2 7l10 5 10-5-10-5z" />
							<path d="M2 17l10 5 10-5" />
							<path d="M2 12l10 5 10-5" />
						</svg>
						{data.currentCollege.name}
						<span class="badge-kind">{INSTITUTION_KIND_LABELS[data.currentCollege.kind]}</span>
					</div>
				{:else}
					<p class="no-college">Nothing picked yet</p>
				{/if}
			</div>

			<form method="POST" action="?/save" use:enhance class="college-form">
				<fieldset class="kind-field">
					<legend class="section-label">What sort of place</legend>
					<div class="kind-options">
						{#each INSTITUTION_KINDS as option (option)}
							<label class="kind-option" class:selected={kind === option}>
								<input
									type="radio"
									name="kind"
									value={option}
									checked={kind === option}
									onchange={() => {
										selectKind(option);
									}}
								/>
								{INSTITUTION_KIND_LABELS[option]}
							</label>
						{/each}
					</div>
					<!-- Said before the choice is made, not after: which calendar shows up without you
					     doing anything is the only difference between these four, so it is what someone
					     is actually choosing between. -->
					<p class="kind-hint">{INSTITUTION_KIND_HINTS[kind]}</p>
				</fieldset>

				<div>
					<label for="college-search" class="section-label">Find it</label>
					<div class="search-wrapper">
						{#key kind}
							<CollegeSearch {kind} inputId="college-search" onselect={handleInstitutionSelect} />
						{/key}
					</div>
				</div>

				{#if selectedInstitution}
					<input type="hidden" name="collegeName" value={selectedInstitution.name} />
					<input type="hidden" name="latitude" value={selectedInstitution.latitude} />
					<input type="hidden" name="longitude" value={selectedInstitution.longitude} />
					<input type="hidden" name="isCustom" value={selectedInstitution.isCustom} />

					<div class="selected-badge">
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<polyline points="20 6 9 17 4 12" />
						</svg>
						{selectedInstitution.name}
					</div>
				{/if}

				<button type="submit" disabled={!selectedInstitution} class="profile-submit">Save</button>
			</form>

			<div class="profile-divider"></div>

			<form method="POST" action="?/logout" use:enhance>
				<button type="submit" class="logout-btn">Log Out</button>
			</form>
		</div>

		<div class="back-link">
			<a href={resolve("/")}>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<path d="M19 12H5M12 19l-7-7 7-7" />
				</svg>
				Back to Map
			</a>
		</div>
	</div>
</div>

<style>
	.profile-page {
		min-height: 100vh;
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-page);
		padding: 16px;
	}

	.profile-container {
		width: 100%;
		max-width: 440px;
		animation: fade-in 0.5s ease;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(12px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.profile-card {
		background: var(--bg-card);
		border: 1px solid var(--border-card);
		border-radius: 14px;
		padding: 32px 24px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
	}

	.profile-header {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 24px;
	}

	.profile-avatar {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		background: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		font-size: 0.9rem;
		color: white;
		text-transform: uppercase;
		flex-shrink: 0;
	}

	.profile-name {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.msg-success {
		margin-bottom: 14px;
		padding: 10px 14px;
		border-radius: 8px;
		background: var(--success-bg);
		border: 1px solid var(--success-border);
		color: var(--success-text);
		font-size: 0.85rem;
	}

	.msg-error {
		margin-bottom: 14px;
		padding: 10px 14px;
		border-radius: 8px;
		background: var(--error-bg);
		border: 1px solid var(--error-border);
		color: var(--error-text);
		font-size: 0.85rem;
	}

	.section-label {
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-secondary);
		margin-bottom: 6px;
		display: block;
	}

	.current-college {
		margin-bottom: 20px;
	}

	.college-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 7px 12px;
		border-radius: 8px;
		background: var(--accent-bg);
		border: 1px solid var(--border-accent);
		color: var(--accent);
		font-size: 0.85rem;
		font-weight: 500;
	}

	.badge-kind {
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--bg-card);
		border: 1px solid var(--border-accent);
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.no-college {
		color: var(--text-muted);
		font-style: italic;
		font-size: 0.85rem;
	}

	.kind-field {
		border: none;
	}

	.kind-options {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 2px;
	}

	.kind-option {
		flex: 1 1 auto;
		text-align: center;
		padding: 8px 10px;
		border-radius: 8px;
		background: var(--bg-input);
		border: 1px solid var(--border-card);
		color: var(--text-secondary);
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			border-color 0.2s,
			color 0.2s;
	}

	.kind-option:hover {
		border-color: var(--border-accent);
	}

	.kind-option.selected {
		background: var(--accent-bg);
		border-color: var(--accent);
		color: var(--accent);
		font-weight: 600;
	}

	/* The radio itself is redundant once the label is the control, but it stays in the accessibility
	   tree and keeps the group keyboard-navigable. */
	.kind-option input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.kind-option:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.kind-hint {
		margin-top: 8px;
		font-size: 0.78rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.college-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.search-wrapper {
		margin-top: 4px;
	}

	.selected-badge {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 9px 12px;
		border-radius: 8px;
		background: var(--success-bg);
		border: 1px solid var(--success-border);
		color: var(--success-text);
		font-size: 0.85rem;
		font-weight: 500;
	}

	.profile-submit {
		padding: 11px;
		border-radius: 8px;
		background: var(--accent);
		color: var(--text-on-accent);
		font-weight: 600;
		font-size: 0.9rem;
		border: none;
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.profile-submit:hover:not(:disabled) {
		opacity: 0.9;
	}

	.profile-submit:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.profile-divider {
		margin: 20px 0;
		border-top: 1px solid var(--border-card);
	}

	.logout-btn {
		width: 100%;
		padding: 10px;
		border-radius: 8px;
		background: transparent;
		border: 1px solid var(--border-card);
		color: var(--text-secondary);
		font-weight: 500;
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.logout-btn:hover {
		background: var(--error-bg);
		border-color: var(--error-border);
		color: var(--error-text);
	}

	.back-link {
		text-align: center;
		margin-top: 16px;
	}

	.back-link a {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--accent);
		text-decoration: none;
		font-size: 0.85rem;
		font-weight: 500;
	}

	.back-link a:hover {
		text-decoration: underline;
	}
</style>
