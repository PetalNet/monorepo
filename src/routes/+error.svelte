<script lang="ts">
	import { page } from '$app/stores';
	import Button from '$lib/components/Button.svelte';
	import { goto } from '$app/navigation';
	
	const errorCode = $derived($page.status);
	const errorMessage = $derived($page.error?.message || 'Something went wrong');
	
	const getErrorTitle = (code: number) => {
		switch (code) {
			case 404:
				return 'Page Not Found';
			case 403:
				return 'Access Denied';
			case 500:
				return 'Server Error';
			default:
				return 'Oops!';
		}
	};
	
	const getErrorEmoji = (code: number) => {
		switch (code) {
			case 404:
				return '🔍';
			case 403:
				return '🚫';
			case 500:
				return '⚠️';
			default:
				return '❌';
		}
	};
	
	const getErrorDescription = (code: number) => {
		switch (code) {
			case 404:
				return "The page you're looking for doesn't exist or has been moved.";
			case 403:
				return "You don't have permission to access this page.";
			case 500:
				return "Something went wrong on our end. We're working to fix it.";
			default:
				return "An unexpected error occurred.";
		}
	};
</script>

<svelte:head>
	<title>{errorCode} - {getErrorTitle(errorCode)} | SlideNight</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center p-4 bg-theater-darker">
	<div class="max-w-2xl w-full text-center space-y-8">
		<!-- Error Icon -->
		<div class="text-9xl mb-4">
			{getErrorEmoji(errorCode)}
		</div>
		
		<!-- Error Code -->
		<div class="space-y-2">
			<h1 class="text-8xl font-bold text-theater-purple">
				{errorCode}
			</h1>
			<h2 class="text-3xl font-semibold text-white">
				{getErrorTitle(errorCode)}
			</h2>
			<p class="text-lg text-gray-400 max-w-md mx-auto">
				{getErrorDescription(errorCode)}
			</p>
		</div>
		
		<!-- Error Message (if available) -->
		{#if errorMessage && errorMessage !== getErrorDescription(errorCode)}
			<div class="bg-theater-dark border border-gray-800 rounded-lg p-4 max-w-md mx-auto">
				<p class="text-sm text-gray-300 font-mono">
					{errorMessage}
				</p>
			</div>
		{/if}
		
		<!-- Action Buttons -->
		<div class="flex flex-col sm:flex-row gap-4 justify-center items-center pt-4">
			<Button onclick={() => window.history.back()} variant="secondary">
				← Go Back
			</Button>
			<Button onclick={() => goto('/')}>
				🏠 Go Home
			</Button>
			{#if errorCode === 404}
				<Button onclick={() => goto('/dashboard')} variant="secondary">
					📊 Dashboard
				</Button>
			{/if}
		</div>
		
		<!-- Fun 404 Suggestions -->
		{#if errorCode === 404}
			<div class="pt-8 border-t border-gray-800 max-w-md mx-auto">
				<p class="text-sm text-gray-500 mb-3">Looking for something?</p>
				<div class="flex flex-wrap gap-2 justify-center text-sm">
					<a href="/auth/signup" class="text-theater-purple hover:underline">Create Account</a>
					<span class="text-gray-600">•</span>
					<a href="/auth/login" class="text-theater-purple hover:underline">Sign In</a>
					<span class="text-gray-600">•</span>
					<a href="/dashboard" class="text-theater-purple hover:underline">Dashboard</a>
				</div>
			</div>
		{/if}
	</div>
</div>
