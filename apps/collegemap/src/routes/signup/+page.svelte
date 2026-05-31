<script lang="ts">
	import { enhance } from '$app/forms';

	let { form } = $props();
</script>

<svelte:head>
	<title>Sign Up - College Map</title>
</svelte:head>

<div class="auth-page">
	<div class="auth-container">
		<div class="auth-card">
			<div class="auth-logo">
				<svg width="36" height="36" viewBox="0 0 24 24" fill="none">
					<circle cx="12" cy="12" r="10" stroke="url(#signupGrad)" stroke-width="2"/>
					<circle cx="12" cy="10" r="3" fill="url(#signupGrad)"/>
					<path d="M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="url(#signupGrad)" stroke-width="2" stroke-linecap="round"/>
					<defs>
						<linearGradient id="signupGrad" x1="0" y1="0" x2="24" y2="24">
							<stop stop-color="#6366f1"/>
							<stop offset="1" stop-color="#0ea5e9"/>
						</linearGradient>
					</defs>
				</svg>
			</div>
			<h1 class="auth-title">Create Account</h1>
			<p class="auth-subtitle">Join the college map</p>

			{#if form?.error}
				<div class="auth-error">{form.error}</div>
			{/if}

			<form method="POST" use:enhance class="auth-form">
				<div class="form-group">
					<label for="firstName" class="form-label">First Name</label>
					<input type="text" id="firstName" name="firstName" required value={form?.firstName ?? ''} class="form-input" />
				</div>
				<div class="form-group">
					<label for="lastName" class="form-label">Last Name</label>
					<input type="text" id="lastName" name="lastName" required value={form?.lastName ?? ''} class="form-input" />
				</div>
				<div class="form-group">
					<label for="password" class="form-label">Password (4-8 characters)</label>
					<input type="password" id="password" name="password" required minlength="4" maxlength="8" class="form-input" />
				</div>
				<button type="submit" class="auth-submit">Sign Up</button>
			</form>

			<p class="auth-link">
				Already have an account?
				<a href="/login">Log in</a>
			</p>
		</div>
	</div>
</div>

<style>
	.auth-page {
		min-height: 100vh;
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-page);
		padding: 16px;
	}

	.auth-container {
		width: 100%;
		max-width: 400px;
		animation: fade-in 0.5s ease;
	}

	@keyframes fade-in {
		from { opacity: 0; transform: translateY(12px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.auth-card {
		background: var(--bg-card);
		border: 1px solid var(--border-card);
		border-radius: 14px;
		padding: 36px 28px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
	}

	.auth-logo {
		display: flex;
		justify-content: center;
		margin-bottom: 16px;
	}

	.auth-title {
		text-align: center;
		font-size: 1.4rem;
		font-weight: 700;
		color: var(--text-primary);
		margin-bottom: 4px;
	}

	.auth-subtitle {
		text-align: center;
		color: var(--text-muted);
		font-size: 0.85rem;
		margin-bottom: 24px;
	}

	.auth-error {
		margin-bottom: 16px;
		padding: 10px 14px;
		border-radius: 8px;
		background: var(--error-bg);
		border: 1px solid var(--error-border);
		color: var(--error-text);
		font-size: 0.85rem;
	}

	.auth-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.form-label {
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.form-input {
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--bg-input);
		border: 1px solid var(--border-card);
		color: var(--text-primary);
		font-size: 0.9rem;
		font-family: 'Inter', sans-serif;
		outline: none;
		transition: border-color 0.2s;
	}

	.form-input:focus {
		border-color: var(--accent);
	}

	.auth-submit {
		margin-top: 6px;
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

	.auth-submit:hover {
		opacity: 0.9;
	}

	.auth-link {
		text-align: center;
		margin-top: 18px;
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.auth-link a {
		color: var(--accent);
		text-decoration: none;
		font-weight: 500;
	}

	.auth-link a:hover {
		text-decoration: underline;
	}
</style>
