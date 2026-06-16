<script lang="ts">
	import { goto } from '$app/navigation';
	
	let {
		title,
		subtitle,
		backLink,
		backText = '← Back to Dashboard',
		children
	}: {
		title: string;
		subtitle?: string;
		backLink?: string;
		backText?: string;
		children?: any;
	} = $props();
</script>

<div class="mb-8">
	{#if backLink}
		<button 
			onclick={() => goto(backLink)}
			class="text-gray-400 hover:text-white mb-4 flex items-center gap-2 transition-colors"
		>
			{backText}
		</button>
	{/if}
	<div class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-4xl font-bold mb-2">{title}</h1>
			{#if subtitle}
				<p class="text-gray-400">{subtitle}</p>
			{/if}
		</div>
		{#if children}
			<div class="flex items-center gap-3">
				{@render children()}
			</div>
		{/if}
	</div>
</div>
