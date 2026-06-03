<script lang="ts">
	import { getTimezoneAbbr } from '$lib/utils/timezone';
	
	let { timezone, date }: { timezone: string; date?: Date | string } = $props();
	
	const abbr = $derived(getTimezoneAbbr(timezone, date ? (typeof date === 'string' ? new Date(date) : date) : undefined));
</script>

<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-900/30 border border-purple-700/50 rounded text-purple-300 text-xs font-medium">
	<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
		<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
	</svg>
	{abbr}
</span>
