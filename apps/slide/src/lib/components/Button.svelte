<script lang="ts">
	let { 
		variant = 'primary',
		type = 'button',
		disabled = false,
		onclick = undefined,
		class: className = '',
		children
	}: {
		variant?: 'primary' | 'secondary' | 'danger';
		type?: 'button' | 'submit';
		disabled?: boolean;
		onclick?: () => void;
		class?: string;
		children: any;
	} = $props();
	
	const baseClasses = 'px-4 py-2 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-theater-darker disabled:opacity-50 disabled:cursor-not-allowed';
	
	const variantClasses = {
		primary: 'bg-theater-purple hover:bg-purple-600 focus:ring-theater-purple',
		secondary: 'bg-gray-700 hover:bg-gray-600 focus:ring-gray-500',
		danger: 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
	};
</script>

<button 
	{type}
	{disabled}
	{onclick}
	class="{baseClasses} {variantClasses[variant]} {className}"
>
	{@render children()}
</button>
