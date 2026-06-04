<script lang="ts">
	import { onMount } from 'svelte';

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
		// Reduce particle count for better performance on older devices
		const particleCount = 15; // Reduced from 25 to 15
		particles = Array.from({ length: particleCount }, (_, i) => ({
			id: i,
			x: Math.random() * 100,
			y: Math.random() * 100,
			size: Math.random() * 3 + 1,
			speedX: (Math.random() - 0.5) * 0.02,
			speedY: (Math.random() - 0.5) * 0.02,
			opacity: Math.random() * 0.3 + 0.1
		}));
		
		// Animate particles - throttle to every 5 frames for better performance
		let frameCount = 0;
		let animationFrameId: number;
		
		const animateParticles = () => {
			frameCount++;
			// Update every 5th frame instead of every 3rd
			if (frameCount % 5 === 0) {
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
			animationFrameId = requestAnimationFrame(animateParticles);
		};
		
		animationFrameId = requestAnimationFrame(animateParticles);
		
		// Cleanup on unmount
		return () => {
			if (animationFrameId) {
				cancelAnimationFrame(animationFrameId);
			}
		};
	});
</script>

<!-- Floating particles background -->
<div class="fixed inset-0 pointer-events-none overflow-hidden z-0 opacity-60">
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
	
	<!-- Ambient spotlights -->
	<div class="absolute w-[500px] h-[500px] rounded-full blur-3xl"
	     style="background: radial-gradient(circle, rgba(139, 92, 246, 0.25) 0%, rgba(139, 92, 246, 0.1) 40%, transparent 70%);
	            animation: spotlightFloat1 25s ease-in-out infinite;
	            left: 10%;
	            top: 20%;">
	</div>
	
	<div class="absolute w-[450px] h-[450px] rounded-full blur-3xl"
	     style="background: radial-gradient(circle, rgba(20, 184, 166, 0.25) 0%, rgba(20, 184, 166, 0.1) 40%, transparent 70%);
	            animation: spotlightFloat2 30s ease-in-out infinite;
	            right: 15%;
	            top: 40%;">
	</div>
	
	<div class="absolute w-[400px] h-[400px] rounded-full blur-3xl"
	     style="background: radial-gradient(circle, rgba(251, 191, 36, 0.2) 0%, rgba(251, 191, 36, 0.08) 40%, transparent 70%);
	            animation: spotlightFloat3 35s ease-in-out infinite;
	            left: 30%;
	            bottom: 20%;">
	</div>
</div>
