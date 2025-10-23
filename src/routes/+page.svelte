<script lang="ts">
	import { goto } from '$app/navigation';
	import Button from '$lib/components/Button.svelte';
	import Card from '$lib/components/Card.svelte';
</script>

<div class="min-h-screen flex flex-col items-center justify-center p-4">
	<div class="max-w-4xl w-full text-center space-y-8">
		<!-- Logo/Title -->
		<div class="space-y-4">
			<h1 class="text-6xl font-bold bg-linear-to-r from-theater-purple to-pink-500 bg-clip-text text-transparent">
				🎤 SlideNight
			</h1>
			<p class="text-2xl text-gray-300">
				Presentation Night Platform
			</p>
		</div>

		<!-- Description -->
		<p class="text-lg text-gray-400 max-w-2xl mx-auto">
			Run structured, sign-up-based presentation nights with live judging and results — 
			while letting people present however they want.
		</p>

		<!-- Action Buttons -->
		<div class="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
			<!-- Host Section -->
			<div class="bg-theater-dark border border-gray-800 rounded-xl p-6 space-y-4">
				<div class="text-3xl mb-2">🎬</div>
				<h3 class="text-xl font-semibold">Host an Event</h3>
				<p class="text-gray-400 text-sm">Create and manage your own presentation night with full control over judging, timing, and results.</p>
				<div class="flex flex-col gap-2">
					<Button 
						onclick={() => goto('/auth/signup')}
						class="w-full"
					>
						Get Started
					</Button>
					<Button 
						variant="secondary"
						onclick={() => goto('/auth/login')}
						class="w-full"
					>
						Sign In
					</Button>
				</div>
			</div>

			<!-- Join Event Section -->
			<div class="bg-theater-dark border border-gray-800 rounded-xl p-6 space-y-4">
				<div class="text-3xl mb-2">🎤</div>
				<h3 class="text-xl font-semibold">Join an Event</h3>
				<p class="text-gray-400 text-sm">Have an event code? Join a presentation night to register your group and submit your presentation.</p>
				<form 
					onsubmit={(e) => {
						e.preventDefault();
						const formData = new FormData(e.currentTarget);
						const code = formData.get('code');
						if (code) goto(`/night/${code}`);
					}}
					class="space-y-3"
				>
					<input 
						type="text" 
						name="code"
						placeholder="Enter event code..." 
						class="w-full px-4 py-3 bg-theater-darker border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-purple focus:border-transparent uppercase font-mono text-center text-lg"
						required
						maxlength="8"
					/>
					<Button type="submit" class="w-full">
						Join Event →
					</Button>
				</form>
			</div>
		</div>

		<!-- Features -->
		<div class="grid md:grid-cols-3 gap-6 pt-12 text-left">
			<Card>
				<div class="text-3xl mb-3">👥</div>
				<h3 class="text-xl font-semibold mb-2">Presentation Registration</h3>
				<p class="text-gray-400">Register presentations, add team members, and submit your content before the deadline.</p>
			</Card>
			<Card>
				<div class="text-3xl mb-3">⭐</div>
				<h3 class="text-xl font-semibold mb-2">Live Judging</h3>
				<p class="text-gray-400">Audience can scan QR codes to vote in real-time with custom rating categories.</p>
			</Card>
			<Card>
				<div class="text-3xl mb-3">🏆</div>
				<h3 class="text-xl font-semibold mb-2">Dramatic Reveals</h3>
				<p class="text-gray-400">Announce winners with confetti, animations, and a full leaderboard.</p>
			</Card>
		</div>
	</div>
</div>
