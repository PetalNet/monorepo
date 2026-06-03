<script lang="ts">
	import ParticleBackground from '$lib/components/ParticleBackground.svelte';
	
	let {
		maxWidth = '4xl',
		children
	}: {
		maxWidth?: string;
		children: any;
	} = $props();
	
	const maxWidthClasses: Record<string, string> = {
		'3xl': 'max-w-3xl',
		'4xl': 'max-w-4xl',
		'5xl': 'max-w-5xl',
		'6xl': 'max-w-6xl',
		'7xl': 'max-w-7xl'
	};
</script>

<div class="min-h-screen bg-theater-background relative overflow-hidden">
	<ParticleBackground />
	
	<div class="relative z-10 {maxWidthClasses[maxWidth]} mx-auto p-4 md:p-8">
		{@render children()}
	</div>
</div>
