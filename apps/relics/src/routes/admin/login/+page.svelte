<svelte:head><title>Admin sign-in · Petal Relics</title></svelte:head>
<div class="form-panel">
	<h1>Welcome to the workshop.</h1>
	<p class="muted">Sign in to add little friends and prepare their tags.</p>
	<a class="btn btn-primary" href="/login/oidc" style="margin-block:32px 24px;width:100%"
		>Sign in with Authentik</a
	>
	<p class="muted small">Found a little friend? Tap its tag to give it a name.</p>
</div>

<style>
	.form-panel {
		max-width: 480px;
		padding: 0;
		margin: 24px auto;
		background: transparent;
	}
	h1 {
		font: 500 2.3125rem/1.14 var(--font-display, Lora, serif);
	}
	.btn {
		min-height: 56px;
		border-radius: 8px;
		font-weight: 700;
		white-space: normal;
	}
</style>
