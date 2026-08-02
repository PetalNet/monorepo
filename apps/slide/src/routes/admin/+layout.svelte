<script lang="ts">
	import { page } from "$app/stores";

	const navItems = [
		{ href: "/admin", label: "Dashboard", icon: "📊" },
		{ href: "/admin/users", label: "Users", icon: "👥" },
		{ href: "/admin/events", label: "Events", icon: "🎯" },
		{ href: "/admin/storage", label: "Storage", icon: "💾" },
		{ href: "/admin/system", label: "System", icon: "⚙️" },
	];
</script>

<div class="min-h-screen bg-gray-50">
	<nav class="border-b bg-white shadow-sm">
		<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
			<div class="flex h-16 justify-between">
				<div class="flex">
					<div class="flex flex-shrink-0 items-center">
						<span class="text-xl font-bold text-red-600">🛡️ Admin Panel</span>
					</div>
					<div class="hidden sm:ml-6 sm:flex sm:space-x-8">
						{#each navItems as item}
							<a
								href={item.href}
								class="inline-flex items-center border-b-2 px-1 pt-1 text-sm font-medium {$page.url
									.pathname === item.href
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
					<a href="/dashboard" class="mr-4 text-sm text-gray-500 hover:text-gray-700">
						← Back to App
					</a>
					<a href="/auth/logout" class="text-sm text-red-600 hover:text-red-700"> Logout </a>
				</div>
			</div>
		</div>
	</nav>

	<main class="mx-auto max-w-7xl py-6 sm:px-6 lg:px-8">
		<slot />
	</main>
</div>
