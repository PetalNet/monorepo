<script lang="ts">
	import { page } from "$app/stores";
	import Button from "$lib/components/Button.svelte";
	import ParticleBackground from "$lib/components/ParticleBackground.svelte";

	const errorMessages: Record<number, { emoji: string; title: string; message: string }> = {
		404: {
			emoji: "🎤",
			title: "Page Not Found",
			message:
				"Looks like this presentation didn't make it to the stage. The page you're looking for doesn't exist.",
		},
		403: {
			emoji: "🚫",
			title: "Access Denied",
			message:
				"You don't have permission to view this presentation. Maybe you need to sign in or join the event first?",
		},
		500: {
			emoji: "🎭",
			title: "Server Error",
			message: "The show must go on... but something went wrong backstage. We're working on it!",
		},
	};

	const status = $page.status;
	const errorInfo = errorMessages[status] || {
		emoji: "⚠️",
		title: "Something Went Wrong",
		message: $page.error?.message || "An unexpected error occurred.",
	};
</script>

<svelte:head>
	<title>{status} - {errorInfo.title} | SlideNight</title>
</svelte:head>

<ParticleBackground />

<div class="flex min-h-screen flex-col items-center justify-center bg-theater-darker p-4">
	<div class="w-full max-w-2xl space-y-6 text-center">
		<!-- Error Icon -->
		<div class="mb-4 animate-bounce text-9xl">
			{errorInfo.emoji}
		</div>

		<!-- Error Code -->
		<div class="text-8xl font-bold text-theater-purple">
			{status}
		</div>

		<!-- Error Title -->
		<h1 class="text-4xl font-bold text-white">
			{errorInfo.title}
		</h1>

		<!-- Error Message -->
		<p class="mx-auto max-w-xl text-xl text-gray-400">
			{errorInfo.message}
		</p>

		<!-- Action Buttons -->
		<div class="flex flex-col justify-center gap-4 pt-6 sm:flex-row">
			<Button onclick={() => window.history.back()}>← Go Back</Button>
			<Button variant="secondary" onclick={() => (window.location.href = "/")}>🏠 Home</Button>
		</div>

		<!-- Technical Details (for development) -->
		{#if import.meta.env.DEV && $page.error?.message}
			<details class="mt-8 rounded-lg border border-gray-800 bg-theater-dark p-4 text-left">
				<summary class="cursor-pointer text-sm text-gray-400 hover:text-gray-300">
					Technical Details
				</summary>
				<pre class="mt-4 overflow-auto text-xs text-red-400">{$page.error.message}</pre>
			</details>
		{/if}
	</div>
</div>

<style>
	@keyframes bounce {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-25px);
		}
	}

	.animate-bounce {
		animation: bounce 2s ease-in-out infinite;
	}
</style>
