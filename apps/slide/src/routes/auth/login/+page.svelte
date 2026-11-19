<script lang="ts">
	import { enhance } from "$app/forms";
	import ParticleBackground from "$lib/components/ParticleBackground.svelte";

	let { form } = $props();
</script>

<ParticleBackground />

<div class="flex min-h-screen items-center justify-center p-4">
	<div class="glass w-full max-w-md rounded-xl p-6">
		<div class="mb-8 text-center">
			<h1 class="mb-2 text-3xl font-bold">Welcome Back</h1>
			<p class="text-gray-400">Sign in to your SlideNight account</p>
		</div>

		<form method="POST" use:enhance class="space-y-4">
			<div>
				<label for="email" class="mb-2 block text-sm font-medium">Email</label>
				<input
					id="email"
					name="email"
					type="email"
					required
					class="bg-theater-dark focus:ring-theater-purple w-full rounded-lg border border-gray-700 px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:ring-2 focus:outline-hidden"
					placeholder="john@example.com"
				/>
			</div>

			<div>
				<label for="password" class="mb-2 block text-sm font-medium">Password</label>
				<input
					id="password"
					name="password"
					type="password"
					required
					class="bg-theater-dark focus:ring-theater-purple w-full rounded-lg border border-gray-700 px-4 py-2 text-white placeholder-gray-500 focus:border-transparent focus:ring-2 focus:outline-hidden"
					placeholder="••••••••"
				/>
			</div>

			{#if form?.error}
				<div class="rounded-sm border border-red-500 bg-red-900/30 px-4 py-3 text-red-200">
					{form.error}
				</div>
			{/if}

			<button
				type="submit"
				class="bg-theater-purple focus:ring-theater-purple focus:ring-offset-theater-darker w-full rounded-lg px-4 py-2 font-semibold transition-all duration-200 hover:bg-purple-600 focus:ring-2 focus:ring-offset-2 focus:outline-hidden"
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
