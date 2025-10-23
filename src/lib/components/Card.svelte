<script lang="ts">
	let { 
		class: className = '',
		children
	}: {
		class?: string;
		children: any;
	} = $props();
</script>

<div class="bg-theater-dark rounded-xl p-6 shadow-lg border border-gray-800 {className}">
	{@render children()}
</div>
