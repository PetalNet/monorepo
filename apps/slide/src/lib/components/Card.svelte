<script lang="ts">
	let { 
		class: className = '',
		children
	}: {
		class?: string;
		children: any;
	} = $props();
</script>

<div class="glass rounded-xl p-6 {className}">
	{@render children()}
</div>
