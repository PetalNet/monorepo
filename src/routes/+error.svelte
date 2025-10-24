<script lang="ts">
	import { page } from '$app/stores';
	import Button from '$lib/components/Button.svelte';
	
	const errorMessages: Record<number, { emoji: string; title: string; message: string }> = {
		404: {
			emoji: '🎤',
			title: 'Page Not Found',
			message: "Looks like this presentation didn't make it to the stage. The page you're looking for doesn't exist."
		},
		403: {
			emoji: '🚫',
			title: 'Access Denied',
			message: "You don't have permission to view this presentation. Maybe you need to sign in or join the event first?"
		},
		500: {
			emoji: '🎭',
			title: 'Server Error',
			message: "The show must go on... but something went wrong backstage. We're working on it!"
		}
	};
	
	const status = $page.status;
	const errorInfo = errorMessages[status] || {
		emoji: '⚠️',
		title: 'Something Went Wrong',
		message: $page.error?.message || 'An unexpected error occurred.'
	};
</script>

<svelte:head>
	<title>{status} - {errorInfo.title} | SlideNight</title>
</svelte:head>

<div class="min-h-screen flex flex-col items-center justify-center p-4 bg-theater-darker">
	<div class="max-w-2xl w-full text-center space-y-6">
		<!-- Error Icon -->
		<div class="text-9xl mb-4 animate-bounce">
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
		<p class="text-xl text-gray-400 max-w-xl mx-auto">
			{errorInfo.message}
		</p>
		
		<!-- Action Buttons -->
		<div class="flex flex-col sm:flex-row gap-4 justify-center pt-6">
			<Button onclick={() => window.history.back()}>
				← Go Back
			</Button>
			<Button variant="secondary" onclick={() => window.location.href = '/'}>
				🏠 Home
			</Button>
		</div>
		
		<!-- Technical Details (for development) -->
		{#if import.meta.env.DEV && $page.error?.message}
			<details class="mt-8 text-left bg-theater-dark border border-gray-800 rounded-lg p-4">
				<summary class="cursor-pointer text-sm text-gray-400 hover:text-gray-300">
					Technical Details
				</summary>
				<pre class="mt-4 text-xs text-red-400 overflow-auto">{$page.error.message}</pre>
			</details>
		{/if}
	</div>
</div>

<style>
	@keyframes bounce {
		0%, 100% {
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
