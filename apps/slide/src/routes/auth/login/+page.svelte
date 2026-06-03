<script lang="ts">
	import { enhance } from '$app/forms';
	import ParticleBackground from '$lib/components/ParticleBackground.svelte';
	
	let { form } = $props();
</script>

<ParticleBackground />

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="glass rounded-xl p-6 max-w-md w-full">
		<div class="text-center mb-8">
			<h1 class="text-3xl font-bold mb-2">Welcome Back</h1>
			<p class="text-gray-400">Sign in to your SlideNight account</p>
		</div>
		
		<form method="POST" use:enhance class="space-y-4">
			<div>
				<label for="email" class="block text-sm font-medium mb-2">Email</label>
				<input 
					id="email"
					name="email"
					type="email" 
					required
					class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
					placeholder="john@example.com"
				/>
			</div>
			
			<div>
				<label for="password" class="block text-sm font-medium mb-2">Password</label>
				<input 
					id="password"
					name="password"
					type="password" 
					required
					class="w-full px-4 py-2 bg-theater-dark border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent"
					placeholder="••••••••"
				/>
			</div>
			
			{#if form?.error}
				<div class="bg-red-900/30 border border-red-500 text-red-200 px-4 py-3 rounded">
					{form.error}
				</div>
			{/if}
			
			<button 
				type="submit" 
				class="w-full px-4 py-2 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker bg-theater-purple hover:bg-purple-600 focus:ring-theater-purple"
			>
				Sign In
			</button>
		</form>
		
		<div class="mt-6 text-center text-gray-400">
			Don't have an account? 
			<a href="/auth/signup" class="text-theater-purple hover:underline">Sign up</a>
		</div>
	</div>
</div>
