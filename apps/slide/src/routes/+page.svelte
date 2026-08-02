<script lang="ts">
	import { goto } from "$app/navigation";
	import Button from "$lib/components/Button.svelte";
	import Card from "$lib/components/Card.svelte";
	import { onMount } from "svelte";

	let showContent = $state(false);
	let spot1El = $state<HTMLElement>();
	let spot2El = $state<HTMLElement>();
	let beam1Style = $state("");
	let beam2Style = $state("");

	// Floating particles
	interface Particle {
		id: number;
		x: number;
		y: number;
		size: number;
		speedX: number;
		speedY: number;
		opacity: number;
	}
	let particles = $state<Particle[]>([]);

	onMount(() => {
		// Stagger the reveal
		setTimeout(() => (showContent = true), 100);

		// Create particles - reduced count for better performance
		const particleCount = 20;
		particles = Array.from({ length: particleCount }, (_, i) => ({
			id: i,
			x: Math.random() * 100,
			y: Math.random() * 100,
			size: Math.random() * 3 + 1,
			speedX: (Math.random() - 0.5) * 0.02,
			speedY: (Math.random() - 0.5) * 0.02,
			opacity: Math.random() * 0.3 + 0.1,
		}));

		// Throttle to every 3 frames for better performance
		let frameCount = 0;
		let animationFrameId: number;

		const updateBeams = () => {
			frameCount++;
			if (frameCount % 3 === 0 && spot1El && spot2El) {
				const rect1 = spot1El.getBoundingClientRect();
				const rect2 = spot2El.getBoundingClientRect();

				// Spotlight centers
				const cx1 = rect1.left + rect1.width / 2;
				const cy1 = rect1.top + rect1.height / 2;
				const cx2 = rect2.left + rect2.width / 2;
				const cy2 = rect2.top + rect2.height / 2;

				const h = window.innerHeight;
				const w = window.innerWidth;

				// Beam origins - slightly off screen at bottom
				const beamOffset = 100; // pixels below screen
				const beam1X = 80; // left-20 = 80px (5rem)
				const beam2X = w - 80; // right-20

				// Beam 1: from bottom-left (with offset) to spotlight 1 center
				const dx1 = cx1 - beam1X;
				const dy1 = h + beamOffset - cy1;
				const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
				const angle1 = Math.atan2(dx1, dy1) * (180 / Math.PI);
				beam1Style = `height: ${len1}px; transform: rotate(${angle1}deg);`;

				// Beam 2: from bottom-right (with offset) to spotlight 2 center
				const dx2 = cx2 - beam2X;
				const dy2 = h + beamOffset - cy2;
				const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
				const angle2 = Math.atan2(dx2, dy2) * (180 / Math.PI);
				beam2Style = `height: ${len2}px; transform: rotate(${angle2}deg);`;

				// Animate particles
				particles = particles.map((p) => {
					let newX = p.x + p.speedX;
					let newY = p.y + p.speedY;

					// Wrap around screen edges
					if (newX < 0) newX = 100;
					if (newX > 100) newX = 0;
					if (newY < 0) newY = 100;
					if (newY > 100) newY = 0;

					return { ...p, x: newX, y: newY };
				});
			}
			animationFrameId = requestAnimationFrame(updateBeams);
		};

		animationFrameId = requestAnimationFrame(updateBeams);

		// Cleanup on unmount
		return () => {
			if (animationFrameId) {
				cancelAnimationFrame(animationFrameId);
			}
		};
	});
</script>

<svelte:head>
	<title>SlideNight - Ultimate Presentation Night Platform</title>
	<meta
		name="description"
		content="Host themed presentation events with live voting, QR code audience participation, timers, and dramatic winner reveals. Perfect for game nights, team building, and creative communities."
	/>
</svelte:head>

<!-- Spotlight background effect -->
<div class="pointer-events-none fixed inset-0 z-0 overflow-hidden opacity-80">
	<!-- Floating particles that shimmer in the light -->
	{#each particles as particle (particle.id)}
		<div
			class="absolute rounded-full bg-white transition-none"
			style="left: {particle.x}vw; 
		            top: {particle.y}vh; 
		            width: {particle.size}px; 
		            height: {particle.size}px;
		            opacity: {particle.opacity};
		            filter: blur(1px);
		            mix-blend-mode: screen;
		            box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);"
		></div>
	{/each}

	<!-- Beam 1: from bottom-left corner to spotlight 1 center -->
	<div
		class="absolute left-20 origin-bottom will-change-transform"
		style="background: linear-gradient(to top, rgba(139, 92, 246, 0.18), rgba(139, 92, 246, 0.12) 85%, rgba(139, 92, 246, 0) 85%, transparent);
	            width: 200px;
	            margin-left: -100px;
	            bottom: -100px;
	            clip-path: polygon(50% 100%, 0% 0%, 100% 0%);
	            filter: blur(40px);
	            {beam1Style}"
	></div>

	<!-- Spotlight 1 - Purple -->
	<div
		bind:this={spot1El}
		class="absolute h-[600px] w-[600px] rounded-full blur-3xl will-change-transform"
		style="background: radial-gradient(circle, rgba(139, 92, 246, 0.4) 0%, rgba(139, 92, 246, 0.15) 40%, transparent 70%);
	            animation: spotlightRoam1 20s ease-in-out infinite;
	            transform: translate(-50%, -50%);"
	></div>

	<!-- Beam 2: from bottom-right corner to spotlight 2 center -->
	<div
		class="absolute right-20 origin-bottom will-change-transform"
		style="background: linear-gradient(to top, rgba(20, 184, 166, 0.18), rgba(20, 184, 166, 0.12) 85%, rgba(20, 184, 166, 0) 85%, transparent);
	            width: 200px;
	            margin-right: -100px;
	            bottom: -100px;
	            clip-path: polygon(50% 100%, 0% 0%, 100% 0%);
	            filter: blur(40px);
	            {beam2Style}"
	></div>

	<!-- Spotlight 2 - Teal -->
	<div
		bind:this={spot2El}
		class="absolute h-[550px] w-[550px] rounded-full blur-3xl will-change-transform"
		style="background: radial-gradient(circle, rgba(20, 184, 166, 0.35) 0%, rgba(20, 184, 166, 0.15) 40%, transparent 70%);
	            animation: spotlightRoam2 25s ease-in-out infinite;
	            transform: translate(-50%, -50%);"
	></div>
</div>

<div class="relative flex min-h-screen flex-col items-center justify-center p-4 pt-24">
	<div class="w-full max-w-5xl space-y-12 text-center">
		<!-- Hero Section -->
		<div class="animate-fade-in space-y-6" class:opacity-0={!showContent}>
			<!-- Mic Icon with Glow -->
			<div class="relative mb-4 inline-block animate-float text-8xl">
				<div
					class="absolute inset-0 scale-150 rounded-full bg-theater-purple-glow/30 blur-2xl"
				></div>
				<span class="relative">🎤</span>
			</div>

			<!-- Title with Gradient -->
			<h1
				class="bg-gradient-to-r from-theater-purple-light via-theater-purple-glow to-pink-500 bg-clip-text text-7xl font-extrabold leading-tight tracking-tight text-transparent md:text-8xl"
			>
				SlideNight
			</h1>

			<p class="text-3xl font-bold tracking-tight text-white md:text-4xl">
				Where Presentations Become <span class="text-theater-gold">Performances</span>
			</p>

			<p class="mx-auto max-w-2xl text-xl leading-relaxed text-gray-300">
				Transform any gathering into an unforgettable show. Teams compete, audiences vote live, and
				winners get the spotlight they deserve.
			</p>
		</div>

		<!-- Energy Badges -->
		<div
			class="flex animate-slide-up flex-wrap justify-center gap-3"
			style="animation-delay: 0.2s"
			class:opacity-0={!showContent}
		>
			<span
				class="group rounded-full border border-theater-purple/30 bg-theater-elevated px-5 py-2.5 text-sm font-medium transition-all duration-300 hover:border-theater-purple/50 hover:bg-theater-purple/10 hover:shadow-glow-sm"
			>
				<span class="inline-block transition-transform group-hover:scale-110">📱</span> QR Code Voting
			</span>
			<span
				class="group rounded-full border border-theater-teal/30 bg-theater-elevated px-5 py-2.5 text-sm font-medium transition-all duration-300 hover:border-theater-teal/50 hover:bg-theater-teal/10 hover:shadow-glow-sm"
			>
				<span class="inline-block transition-transform group-hover:scale-110">⏱️</span> Live Timer Control
			</span>
			<span
				class="group rounded-full border border-theater-gold/30 bg-theater-elevated px-5 py-2.5 text-sm font-medium transition-all duration-300 hover:border-theater-gold/50 hover:bg-theater-gold/10 hover:shadow-glow-sm"
			>
				<span class="inline-block transition-transform group-hover:scale-110">🏆</span> Automatic Scoring
			</span>
			<span
				class="group rounded-full border border-pink-500/30 bg-theater-elevated px-5 py-2.5 text-sm font-medium transition-all duration-300 hover:border-pink-500/50 hover:bg-pink-500/10 hover:shadow-glow-sm"
			>
				<span class="inline-block transition-transform group-hover:scale-110">🎉</span> Confetti Reveals
			</span>
		</div>

		<!-- Action Cards -->
		<div
			class="mx-auto grid max-w-4xl animate-slide-up gap-6 md:grid-cols-2"
			style="animation-delay: 0.4s"
			class:opacity-0={!showContent}
		>
			<!-- Host Section -->
			<div
				class="group relative space-y-6 overflow-hidden rounded-2xl border border-gray-800/50 bg-theater-elevated p-8 transition-all duration-300 hover:border-theater-purple/50 hover:shadow-stage"
			>
				<!-- Glow effect on hover -->
				<div
					class="absolute inset-0 bg-gradient-to-br from-theater-purple/5 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
				></div>

				<div class="relative z-10 space-y-6">
					<div
						class="mb-2 inline-block text-5xl transition-transform duration-300 group-hover:scale-110"
					>
						🎬
					</div>
					<div class="space-y-3">
						<h3 class="text-2xl font-bold text-white">Host an Event</h3>
						<p class="leading-relaxed text-gray-400">
							Take the stage. Create your show, set the theme, define categories, and control every
							moment — from registration to the final reveal.
						</p>
					</div>
					<div class="flex flex-col gap-3">
						<button
							onclick={() => goto("/auth/signup")}
							class="w-full rounded-xl bg-theater-purple px-6 py-3.5 font-semibold text-white transition-all duration-200 hover:scale-105 hover:bg-theater-purple/90 hover:shadow-glow"
						>
							Create Account
						</button>
						<button
							onclick={() => goto("/auth/login")}
							class="w-full rounded-xl border border-gray-700 bg-theater-dark px-6 py-3.5 font-semibold text-white transition-all duration-200 hover:border-theater-purple/50 hover:bg-theater-elevated"
						>
							Sign In
						</button>
					</div>
				</div>
			</div>

			<!-- Join Event Section -->
			<div
				class="group relative space-y-6 overflow-hidden rounded-2xl border border-gray-800/50 bg-theater-elevated p-8 transition-all duration-300 hover:border-theater-teal/30 hover:shadow-glow-sm"
			>
				<!-- Hover Glow Overlay -->
				<div
					class="pointer-events-none absolute inset-0 bg-gradient-to-br from-theater-teal/5 via-transparent to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
				></div>

				<div class="relative z-10">
					<div
						class="mb-3 inline-block text-4xl transition-transform duration-300 group-hover:scale-110"
					>
						🎤
					</div>
					<h3 class="mb-2 text-2xl font-bold tracking-tight">Join an Event</h3>
					<p class="leading-relaxed text-gray-400">
						Got an event code from your host? Enter it below to register your team, add members, and
						submit your presentation.
					</p>
				</div>

				<form
					onsubmit={(e) => {
						e.preventDefault();
						const formData = new FormData(e.currentTarget);
						const code = formData.get("code");
						if (code) goto(`/night/${code}`);
					}}
					class="relative z-10 space-y-4"
				>
					<input
						type="text"
						name="code"
						placeholder="Enter event code..."
						class="w-full rounded-xl border border-gray-700 bg-theater-dark px-5 py-4 text-center font-mono text-xl uppercase tracking-widest text-white placeholder-gray-500 transition-all duration-200 focus:border-theater-teal focus:shadow-glow-sm focus:outline-none focus:ring-2 focus:ring-theater-teal"
						required
						maxlength="8"
					/>
					<Button type="submit" class="w-full">Join Event →</Button>
				</form>
			</div>
		</div>

		<!-- Features -->
		<div class="grid gap-8 pt-16 text-left md:grid-cols-3">
			<!-- Feature 1 - Easy Registration -->
			<div
				class="animate-fade-in rounded-2xl border border-gray-800/50 bg-theater-elevated p-8 opacity-0 transition-all duration-300 [animation-delay:0.6s] [animation-fill-mode:forwards] hover:border-theater-purple/30 hover:shadow-glow-sm"
			>
				<div class="mb-4 inline-block text-4xl transition-transform duration-300 hover:scale-110">
					📝
				</div>
				<h3 class="mb-3 text-2xl font-bold tracking-tight">Easy Registration</h3>
				<p class="leading-relaxed text-gray-400">
					Teams sign up with custom group names and emojis. Set submission deadlines and collect
					presentation links before the event starts.
				</p>
			</div>

			<!-- Feature 2 - Live Presentation Mode -->
			<div
				class="animate-fade-in rounded-2xl border border-gray-800/50 bg-theater-elevated p-8 opacity-0 transition-all duration-300 [animation-delay:0.8s] [animation-fill-mode:forwards] hover:border-theater-teal/30 hover:shadow-glow-sm"
			>
				<div class="mb-4 inline-block text-4xl transition-transform duration-300 hover:scale-110">
					🎬
				</div>
				<h3 class="mb-3 text-2xl font-bold tracking-tight">Live Presentation Mode</h3>
				<p class="leading-relaxed text-gray-400">
					Navigate between presentations with timers, audience voting via QR codes, and custom
					rating categories you define.
				</p>
			</div>

			<!-- Feature 3 - Dramatic Results -->
			<div
				class="animate-fade-in rounded-2xl border border-gray-800/50 bg-theater-elevated p-8 opacity-0 transition-all duration-300 [animation-delay:1.0s] [animation-fill-mode:forwards] hover:border-theater-gold/30 hover:shadow-glow-sm"
			>
				<div class="mb-4 inline-block text-4xl transition-transform duration-300 hover:scale-110">
					🏆
				</div>
				<h3 class="mb-3 text-2xl font-bold tracking-tight">Dramatic Results</h3>
				<p class="leading-relaxed text-gray-400">
					Reveal winners with confetti animations, category awards, and complete leaderboards. Make
					every reveal memorable.
				</p>
			</div>
		</div>

		<!-- Use Cases -->
		<div class="mt-8 border-t border-gray-800/50 pt-16">
			<h3 class="mb-8 text-center text-2xl font-bold tracking-tight">Perfect For:</h3>
			<div class="flex flex-wrap justify-center gap-4">
				<span
					class="rounded-full border border-gray-800/50 bg-theater-elevated px-6 py-3 text-gray-300 transition-all duration-200 hover:border-theater-purple/30 hover:text-theater-purple-light"
				>
					<span class="mr-2">🎓</span>College Organizations
				</span>
				<span
					class="rounded-full border border-gray-800/50 bg-theater-elevated px-6 py-3 text-gray-300 transition-all duration-200 hover:border-theater-teal/30 hover:text-theater-teal"
				>
					<span class="mr-2">🏢</span>Team Building Events
				</span>
				<span
					class="rounded-full border border-gray-800/50 bg-theater-elevated px-6 py-3 text-gray-300 transition-all duration-200 hover:border-theater-gold/30 hover:text-theater-gold"
				>
					<span class="mr-2">🎮</span>Game Nights
				</span>
				<span
					class="rounded-full border border-gray-800/50 bg-theater-elevated px-6 py-3 text-gray-300 transition-all duration-200 hover:border-pink-400/30 hover:text-pink-400"
				>
					<span class="mr-2">🎨</span>Creative Communities
				</span>
				<span
					class="rounded-full border border-gray-800/50 bg-theater-elevated px-6 py-3 text-gray-300 transition-all duration-200 hover:border-theater-purple/30 hover:text-theater-purple-light"
				>
					<span class="mr-2">🎉</span>Party Competitions
				</span>
			</div>
		</div>
	</div>
</div>
