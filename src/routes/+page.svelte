<script lang="ts">
	import { goto } from '$app/navigation';
	import Button from '$lib/components/Button.svelte';
	import Card from '$lib/components/Card.svelte';
	import { onMount } from 'svelte';
	
	let showContent = $state(false);
	let spot1El: HTMLElement;
	let spot2El: HTMLElement;
	let beam1Style = $state('');
	let beam2Style = $state('');
	
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
		setTimeout(() => showContent = true, 100);
		
		// Create particles - reduced count for better performance
		const particleCount = 20;
		particles = Array.from({ length: particleCount }, (_, i) => ({
			id: i,
			x: Math.random() * 100,
			y: Math.random() * 100,
			size: Math.random() * 3 + 1,
			speedX: (Math.random() - 0.5) * 0.02,
			speedY: (Math.random() - 0.5) * 0.02,
			opacity: Math.random() * 0.3 + 0.1
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
				const dy1 = (h + beamOffset) - cy1;
				const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
				const angle1 = Math.atan2(dx1, dy1) * (180 / Math.PI);
				beam1Style = `height: ${len1}px; transform: rotate(${angle1}deg);`;
				
				// Beam 2: from bottom-right (with offset) to spotlight 2 center
				const dx2 = cx2 - beam2X;
				const dy2 = (h + beamOffset) - cy2;
				const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
				const angle2 = Math.atan2(dx2, dy2) * (180 / Math.PI);
				beam2Style = `height: ${len2}px; transform: rotate(${angle2}deg);`;
				
				// Animate particles
				particles = particles.map(p => {
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
	<meta name="description" content="Host themed presentation events with live voting, QR code audience participation, timers, and dramatic winner reveals. Perfect for game nights, team building, and creative communities." />
</svelte:head>

<!-- Spotlight background effect -->
<div class="fixed inset-0 pointer-events-none overflow-hidden z-0 opacity-80">
	<!-- Floating particles that shimmer in the light -->
	{#each particles as particle (particle.id)}
		<div class="absolute rounded-full bg-white transition-none"
		     style="left: {particle.x}vw; 
		            top: {particle.y}vh; 
		            width: {particle.size}px; 
		            height: {particle.size}px;
		            opacity: {particle.opacity};
		            filter: blur(1px);
		            mix-blend-mode: screen;
		            box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);">
		</div>
	{/each}
	
	<!-- Beam 1: from bottom-left corner to spotlight 1 center -->
	<div class="absolute left-20 origin-bottom will-change-transform"
	     style="background: linear-gradient(to top, rgba(139, 92, 246, 0.18), rgba(139, 92, 246, 0.12) 85%, rgba(139, 92, 246, 0) 85%, transparent);
	            width: 200px;
	            margin-left: -100px;
	            bottom: -100px;
	            clip-path: polygon(50% 100%, 0% 0%, 100% 0%);
	            filter: blur(40px);
	            {beam1Style}">
	</div>
	
	<!-- Spotlight 1 - Purple -->
	<div bind:this={spot1El} class="absolute w-[600px] h-[600px] rounded-full blur-3xl will-change-transform"
	     style="background: radial-gradient(circle, rgba(139, 92, 246, 0.4) 0%, rgba(139, 92, 246, 0.15) 40%, transparent 70%);
	            animation: spotlightRoam1 20s ease-in-out infinite;
	            transform: translate(-50%, -50%);">
	</div>
	
	<!-- Beam 2: from bottom-right corner to spotlight 2 center -->
	<div class="absolute right-20 origin-bottom will-change-transform"
	     style="background: linear-gradient(to top, rgba(20, 184, 166, 0.18), rgba(20, 184, 166, 0.12) 85%, rgba(20, 184, 166, 0) 85%, transparent);
	            width: 200px;
	            margin-right: -100px;
	            bottom: -100px;
	            clip-path: polygon(50% 100%, 0% 0%, 100% 0%);
	            filter: blur(40px);
	            {beam2Style}">
	</div>
	
	<!-- Spotlight 2 - Teal -->
	<div bind:this={spot2El} class="absolute w-[550px] h-[550px] rounded-full blur-3xl will-change-transform"
	     style="background: radial-gradient(circle, rgba(20, 184, 166, 0.35) 0%, rgba(20, 184, 166, 0.15) 40%, transparent 70%);
	            animation: spotlightRoam2 25s ease-in-out infinite;
	            transform: translate(-50%, -50%);">
	</div>
</div>

<div class="min-h-screen flex flex-col items-center justify-center p-4 pt-24 relative">
	<div class="max-w-5xl w-full text-center space-y-12">
		<!-- Hero Section -->
		<div class="space-y-6 animate-fade-in" class:opacity-0={!showContent}>
			<!-- Mic Icon with Glow -->
			<div class="text-8xl animate-float mb-4 relative inline-block">
				<div class="absolute inset-0 blur-2xl bg-theater-purple-glow/30 rounded-full scale-150"></div>
				<span class="relative">🎤</span>
			</div>
			
			<!-- Title with Gradient -->
			<h1 class="text-7xl md:text-8xl font-extrabold tracking-tight bg-gradient-to-r from-theater-purple-light via-theater-purple-glow to-pink-500 bg-clip-text text-transparent leading-tight">
				SlideNight
			</h1>
			
			<p class="text-3xl md:text-4xl font-bold text-white tracking-tight">
				Where Presentations Become <span class="text-theater-gold">Performances</span>
			</p>
			
			<p class="text-xl text-gray-300 max-w-2xl mx-auto leading-relaxed">
				Transform any gathering into an unforgettable show. Teams compete, audiences vote live, 
				and winners get the spotlight they deserve.
			</p>
		</div>

		<!-- Energy Badges -->
		<div class="flex flex-wrap justify-center gap-3 animate-slide-up" style="animation-delay: 0.2s" class:opacity-0={!showContent}>
			<span class="px-5 py-2.5 bg-theater-elevated border border-theater-purple/30 rounded-full text-sm font-medium hover:bg-theater-purple/10 hover:border-theater-purple/50 hover:shadow-glow-sm transition-all duration-300 group">
				<span class="group-hover:scale-110 inline-block transition-transform">📱</span> QR Code Voting
			</span>
			<span class="px-5 py-2.5 bg-theater-elevated border border-theater-teal/30 rounded-full text-sm font-medium hover:bg-theater-teal/10 hover:border-theater-teal/50 hover:shadow-glow-sm transition-all duration-300 group">
				<span class="group-hover:scale-110 inline-block transition-transform">⏱️</span> Live Timer Control
			</span>
			<span class="px-5 py-2.5 bg-theater-elevated border border-theater-gold/30 rounded-full text-sm font-medium hover:bg-theater-gold/10 hover:border-theater-gold/50 hover:shadow-glow-sm transition-all duration-300 group">
				<span class="group-hover:scale-110 inline-block transition-transform">🏆</span> Automatic Scoring
			</span>
			<span class="px-5 py-2.5 bg-theater-elevated border border-pink-500/30 rounded-full text-sm font-medium hover:bg-pink-500/10 hover:border-pink-500/50 hover:shadow-glow-sm transition-all duration-300 group">
				<span class="group-hover:scale-110 inline-block transition-transform">🎉</span> Confetti Reveals
			</span>
		</div>

		<!-- Action Cards -->
		<div class="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto animate-slide-up" style="animation-delay: 0.4s" class:opacity-0={!showContent}>
			<!-- Host Section -->
			<div class="bg-theater-elevated border border-gray-800/50 rounded-2xl p-8 space-y-6 hover:border-theater-purple/50 hover:shadow-stage transition-all duration-300 group relative overflow-hidden">
				<!-- Glow effect on hover -->
				<div class="absolute inset-0 bg-gradient-to-br from-theater-purple/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
				
				<div class="relative z-10 space-y-6">
					<div class="text-5xl mb-2 group-hover:scale-110 transition-transform duration-300 inline-block">🎬</div>
					<div class="space-y-3">
						<h3 class="text-2xl font-bold text-white">Host an Event</h3>
						<p class="text-gray-400 leading-relaxed">
							Take the stage. Create your show, set the theme, define categories, and control every moment — from registration to the final reveal.
						</p>
					</div>
					<div class="flex flex-col gap-3">
						<button 
							onclick={() => goto('/auth/signup')}
							class="w-full px-6 py-3.5 bg-theater-purple hover:bg-theater-purple/90 text-white rounded-xl font-semibold hover:shadow-glow hover:scale-105 transition-all duration-200"
						>
							Create Account
						</button>
						<button 
							onclick={() => goto('/auth/login')}
							class="w-full px-6 py-3.5 bg-theater-dark hover:bg-theater-elevated border border-gray-700 hover:border-theater-purple/50 text-white rounded-xl font-semibold transition-all duration-200"
						>
							Sign In
						</button>
					</div>
				</div>
			</div>

			<!-- Join Event Section -->
			<div class="relative group bg-theater-elevated border border-gray-800/50 rounded-2xl p-8 space-y-6 hover:border-theater-teal/30 transition-all duration-300 hover:shadow-glow-sm overflow-hidden">
				<!-- Hover Glow Overlay -->
				<div class="absolute inset-0 bg-gradient-to-br from-theater-teal/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"></div>
				
				<div class="relative z-10">
					<div class="text-4xl mb-3 transition-transform duration-300 group-hover:scale-110 inline-block">🎤</div>
					<h3 class="text-2xl font-bold mb-2 tracking-tight">Join an Event</h3>
					<p class="text-gray-400 leading-relaxed">Got an event code from your host? Enter it below to register your team, add members, and submit your presentation.</p>
				</div>
				
				<form 
					onsubmit={(e) => {
						e.preventDefault();
						const formData = new FormData(e.currentTarget);
						const code = formData.get('code');
						if (code) goto(`/night/${code}`);
					}}
					class="space-y-4 relative z-10"
				>
					<input 
						type="text" 
						name="code"
						placeholder="Enter event code..." 
						class="w-full px-5 py-4 bg-theater-dark border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-theater-teal focus:border-theater-teal focus:shadow-glow-sm uppercase font-mono text-center text-xl tracking-widest transition-all duration-200"
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
		<div class="grid md:grid-cols-3 gap-8 pt-16 text-left">
			<!-- Feature 1 - Easy Registration -->
			<div class="bg-theater-elevated border border-gray-800/50 rounded-2xl p-8 hover:border-theater-purple/30 hover:shadow-glow-sm transition-all duration-300 animate-fade-in [animation-delay:0.6s] [animation-fill-mode:forwards] opacity-0">
				<div class="text-4xl mb-4 transition-transform duration-300 hover:scale-110 inline-block">📝</div>
				<h3 class="text-2xl font-bold mb-3 tracking-tight">Easy Registration</h3>
				<p class="text-gray-400 leading-relaxed">Teams sign up with custom group names and emojis. Set submission deadlines and collect presentation links before the event starts.</p>
			</div>
			
			<!-- Feature 2 - Live Presentation Mode -->
			<div class="bg-theater-elevated border border-gray-800/50 rounded-2xl p-8 hover:border-theater-teal/30 hover:shadow-glow-sm transition-all duration-300 animate-fade-in [animation-delay:0.8s] [animation-fill-mode:forwards] opacity-0">
				<div class="text-4xl mb-4 transition-transform duration-300 hover:scale-110 inline-block">🎬</div>
				<h3 class="text-2xl font-bold mb-3 tracking-tight">Live Presentation Mode</h3>
				<p class="text-gray-400 leading-relaxed">Navigate between presentations with timers, audience voting via QR codes, and custom rating categories you define.</p>
			</div>
			
			<!-- Feature 3 - Dramatic Results -->
			<div class="bg-theater-elevated border border-gray-800/50 rounded-2xl p-8 hover:border-theater-gold/30 hover:shadow-glow-sm transition-all duration-300 animate-fade-in [animation-delay:1.0s] [animation-fill-mode:forwards] opacity-0">
				<div class="text-4xl mb-4 transition-transform duration-300 hover:scale-110 inline-block">🏆</div>
				<h3 class="text-2xl font-bold mb-3 tracking-tight">Dramatic Results</h3>
				<p class="text-gray-400 leading-relaxed">Reveal winners with confetti animations, category awards, and complete leaderboards. Make every reveal memorable.</p>
			</div>
		</div>

		<!-- Use Cases -->
		<div class="pt-16 mt-8 border-t border-gray-800/50">
			<h3 class="text-2xl font-bold mb-8 text-center tracking-tight">Perfect For:</h3>
			<div class="flex flex-wrap justify-center gap-4">
				<span class="px-6 py-3 bg-theater-elevated border border-gray-800/50 rounded-full text-gray-300 hover:border-theater-purple/30 hover:text-theater-purple-light transition-all duration-200">
					<span class="mr-2">🎓</span>College Organizations
				</span>
				<span class="px-6 py-3 bg-theater-elevated border border-gray-800/50 rounded-full text-gray-300 hover:border-theater-teal/30 hover:text-theater-teal transition-all duration-200">
					<span class="mr-2">🏢</span>Team Building Events
				</span>
				<span class="px-6 py-3 bg-theater-elevated border border-gray-800/50 rounded-full text-gray-300 hover:border-theater-gold/30 hover:text-theater-gold transition-all duration-200">
					<span class="mr-2">🎮</span>Game Nights
				</span>
				<span class="px-6 py-3 bg-theater-elevated border border-gray-800/50 rounded-full text-gray-300 hover:border-pink-400/30 hover:text-pink-400 transition-all duration-200">
					<span class="mr-2">🎨</span>Creative Communities
				</span>
				<span class="px-6 py-3 bg-theater-elevated border border-gray-800/50 rounded-full text-gray-300 hover:border-theater-purple/30 hover:text-theater-purple-light transition-all duration-200">
					<span class="mr-2">🎉</span>Party Competitions
				</span>
			</div>
		</div>
	</div>
</div>
