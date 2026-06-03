<script lang="ts">
	import { page } from '$app/stores';
	
	const navItems = [
		{ href: '/admin', label: 'Dashboard', icon: '📊' },
		{ href: '/admin/users', label: 'Users', icon: '👥' },
		{ href: '/admin/events', label: 'Events', icon: '🎯' },
		{ href: '/admin/storage', label: 'Storage', icon: '💾' },
		{ href: '/admin/system', label: 'System', icon: '⚙️' },
	];
</script>

<div class="min-h-screen bg-gray-50">
	<nav class="bg-white shadow-sm border-b">
		<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
			<div class="flex justify-between h-16">
				<div class="flex">
					<div class="flex-shrink-0 flex items-center">
						<span class="text-xl font-bold text-red-600">🛡️ Admin Panel</span>
					</div>
					<div class="hidden sm:ml-6 sm:flex sm:space-x-8">
						{#each navItems as item}
							<a
								href={item.href}
								class="inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium {$page.url.pathname === item.href
									? 'border-red-500 text-gray-900'
									: 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'}"
							>
								<span class="mr-2">{item.icon}</span>
								{item.label}
							</a>
						{/each}
					</div>
				</div>
				<div class="flex items-center">
					<a
						href="/dashboard"
						class="text-sm text-gray-500 hover:text-gray-700 mr-4"
					>
						← Back to App
					</a>
					<a
						href="/auth/logout"
						class="text-sm text-red-600 hover:text-red-700"
					>
						Logout
					</a>
				</div>
			</div>
		</div>
	</nav>

	<main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
		<slot />
	</main>
</div>
