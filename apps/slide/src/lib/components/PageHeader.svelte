<script lang="ts">
	import { goto } from "$app/navigation";

	let {
		title,
		subtitle,
		backLink,
		backText = "← Back to Dashboard",
		children,
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
			class="mb-4 flex items-center gap-2 text-gray-400 transition-colors hover:text-white"
		>
			{backText}
		</button>
	{/if}
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h1 class="mb-2 text-4xl font-bold">{title}</h1>
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
