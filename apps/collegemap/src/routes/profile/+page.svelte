<script lang="ts">
	import { enhance } from '$app/forms';
	import CollegeSearch from '$lib/components/CollegeSearch.svelte';

	let { data, form } = $props();

	let selectedCollege = $state<{
		name: string;
		latitude: number;
		longitude: number;
		isCustom: boolean;
	} | null>(null);

	function handleCollegeSelect(college: {
		name: string;
		latitude: number;
		longitude: number;
		isCustom: boolean;
	}) {
		selectedCollege = college;
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
				<div class="msg-success">College updated successfully!</div>
			{/if}

			{#if form?.error}
				<div class="msg-error">{form.error}</div>
			{/if}

			<div class="current-college">
				<h2 class="section-label">Current College</h2>
				{#if data.currentCollege}
					<div class="college-badge">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M12 2L2 7l10 5 10-5-10-5z"/>
							<path d="M2 17l10 5 10-5"/>
							<path d="M2 12l10 5 10-5"/>
						</svg>
						{data.currentCollege.name}
					</div>
				{:else}
					<p class="no-college">No college selected</p>
				{/if}
			</div>

			<form method="POST" action="?/save" use:enhance class="college-form">
				<div>
					<label for="college-search" class="section-label">Select Your College</label>
					<div class="search-wrapper">
						<CollegeSearch inputId="college-search" onselect={handleCollegeSelect} />
					</div>
				</div>

				{#if selectedCollege}
					<input type="hidden" name="collegeName" value={selectedCollege.name} />
					<input type="hidden" name="latitude" value={selectedCollege.latitude} />
					<input type="hidden" name="longitude" value={selectedCollege.longitude} />
					<input type="hidden" name="isCustom" value={selectedCollege.isCustom} />

					<div class="selected-badge">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="20 6 9 17 4 12"/>
						</svg>
						{selectedCollege.name}
					</div>
				{/if}

				<button type="submit" disabled={!selectedCollege} class="profile-submit">
					Save College
				</button>
			</form>

			<div class="profile-divider"></div>

			<form method="POST" action="?/logout" use:enhance>
				<button type="submit" class="logout-btn">Log Out</button>
			</form>
		</div>

		<div class="back-link">
			<a href="/">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M19 12H5M12 19l-7-7 7-7"/>
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
		from { opacity: 0; transform: translateY(12px); }
		to { opacity: 1; transform: translateY(0); }
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

	.no-college {
		color: var(--text-muted);
		font-style: italic;
		font-size: 0.85rem;
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
