<script lang="ts">
	import { goto } from '$app/navigation';
	import Button from '$lib/components/Button.svelte';
	import Card from '$lib/components/Card.svelte';
</script>

<svelte:head>
	<title>SlideNight - Ultimate Presentation Night Platform</title>
	<meta name="description" content="Host themed presentation events with live voting, QR code audience participation, timers, and dramatic winner reveals. Perfect for game nights, team building, and creative communities." />
</svelte:head>

<div class="min-h-screen flex flex-col items-center justify-center p-4">
	<div class="max-w-4xl w-full text-center space-y-8">
		<!-- Logo/Title -->
		<div class="space-y-4">
			<h1 class="text-6xl font-bold bg-gradient-to-r from-theater-purple to-pink-500 bg-clip-text text-transparent">
				🎤 SlideNight
			</h1>
			<p class="text-2xl text-gray-300 font-semibold">
				The Ultimate Presentation Night Platform
			</p>
			<p class="text-lg text-gray-400 max-w-2xl mx-auto">
				Host themed presentation events where teams compete, audiences vote in real-time, 
				and winners are revealed with style. Perfect for game nights, team building, 
				student organizations, and creative communities.
			</p>
		</div>

		<!-- Quick Value Props -->
		<div class="flex flex-wrap justify-center gap-4 text-sm">
			<span class="px-4 py-2 bg-theater-dark border border-gray-700 rounded-full">
				📱 QR Code Voting
			</span>
			<span class="px-4 py-2 bg-theater-dark border border-gray-700 rounded-full">
				⏱️ Live Timer Control
			</span>
			<span class="px-4 py-2 bg-theater-dark border border-gray-700 rounded-full">
				🏆 Automatic Scoring
			</span>
			<span class="px-4 py-2 bg-theater-dark border border-gray-700 rounded-full">
				🎉 Confetti Reveals
			</span>
		</div>

		<!-- Action Buttons -->
		<div class="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
			<!-- Host Section -->
			<div class="bg-theater-dark border border-gray-800 rounded-xl p-6 space-y-4">
				<div class="text-3xl mb-2">🎬</div>
				<h3 class="text-xl font-semibold">Host an Event</h3>
				<p class="text-gray-400 text-sm">Create your own presentation night. Set themes, define voting categories, manage teams, and control the live event from start to finish.</p>
				<div class="flex flex-col gap-2">
					<Button 
						onclick={() => goto('/auth/signup')}
						class="w-full"
					>
						Create Account
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
				<p class="text-gray-400 text-sm">Got an event code from your host? Enter it below to register your team, add members, and submit your presentation.</p>
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
				<div class="text-3xl mb-3">�</div>
				<h3 class="text-xl font-semibold mb-2">Easy Registration</h3>
				<p class="text-gray-400">Teams sign up with custom group names and emojis. Set submission deadlines and collect presentation links before the event starts.</p>
			</Card>
			<Card>
				<div class="text-3xl mb-3">🎬</div>
				<h3 class="text-xl font-semibold mb-2">Live Presentation Mode</h3>
				<p class="text-gray-400">Navigate between presentations with timers, audience voting via QR codes, and custom rating categories you define.</p>
			</Card>
			<Card>
				<div class="text-3xl mb-3">🏆</div>
				<h3 class="text-xl font-semibold mb-2">Dramatic Results</h3>
				<p class="text-gray-400">Reveal winners with confetti animations, category awards, and complete leaderboards. Make every reveal memorable.</p>
			</Card>
		</div>

		<!-- Use Cases -->
		<div class="pt-8 border-t border-gray-800">
			<h3 class="text-xl font-semibold mb-4 text-gray-300">Perfect For:</h3>
			<div class="flex flex-wrap justify-center gap-3 text-sm text-gray-400">
				<span>🎓 College Organizations</span>
				<span>•</span>
				<span>🏢 Team Building Events</span>
				<span>•</span>
				<span>🎮 Game Nights</span>
				<span>•</span>
				<span>🎨 Creative Communities</span>
				<span>•</span>
				<span>🎉 Party Competitions</span>
			</div>
		</div>
	</div>
</div>
