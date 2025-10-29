<script lang="ts">
	import type { PageData } from './$types';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	
	export let data: PageData;
	
	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
	}
	
	function formatUptime(seconds: number): string {
		const days = Math.floor(seconds / 86400);
		const hours = Math.floor((seconds % 86400) / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		
		if (days > 0) return `${days}d ${hours}h ${minutes}m`;
		if (hours > 0) return `${hours}h ${minutes}m`;
		return `${minutes}m`;
	}
	
	function formatDate(date: string | Date): string {
		return new Date(date).toLocaleString();
	}
</script>

<svelte:head>
	<title>Admin Dashboard - Slide</title>
</svelte:head>

<PageContainer>
	<PageHeader 
		title="Dashboard"
		subtitle="Admin overview and system statistics"
	/>

	<!-- Stats Grid -->
	<div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 mb-8">
		<div class="bg-white overflow-hidden shadow rounded-lg">
			<div class="p-5">
				<div class="flex items-center">
					<div class="flex-shrink-0">
						<span class="text-4xl">👥</span>
					</div>
					<div class="ml-5 w-0 flex-1">
						<dl>
							<dt class="text-sm font-medium text-gray-500 truncate">Total Users</dt>
							<dd class="text-3xl font-semibold text-gray-900">{data.stats.users}</dd>
						</dl>
					</div>
				</div>
			</div>
		</div>

		<div class="bg-white overflow-hidden shadow rounded-lg">
			<div class="p-5">
				<div class="flex items-center">
					<div class="flex-shrink-0">
						<span class="text-4xl">🎯</span>
					</div>
					<div class="ml-5 w-0 flex-1">
						<dl>
							<dt class="text-sm font-medium text-gray-500 truncate">Total Events</dt>
							<dd class="text-3xl font-semibold text-gray-900">{data.stats.events}</dd>
						</dl>
					</div>
				</div>
			</div>
		</div>

		<div class="bg-white overflow-hidden shadow rounded-lg">
			<div class="p-5">
				<div class="flex items-center">
					<div class="flex-shrink-0">
						<span class="text-4xl">📊</span>
					</div>
					<div class="ml-5 w-0 flex-1">
						<dl>
							<dt class="text-sm font-medium text-gray-500 truncate">Total Groups</dt>
							<dd class="text-3xl font-semibold text-gray-900">{data.stats.groups}</dd>
						</dl>
					</div>
				</div>
			</div>
		</div>

		<div class="bg-white overflow-hidden shadow rounded-lg">
			<div class="p-5">
				<div class="flex items-center">
					<div class="flex-shrink-0">
						<span class="text-4xl">⭐</span>
					</div>
					<div class="ml-5 w-0 flex-1">
						<dl>
							<dt class="text-sm font-medium text-gray-500 truncate">Total Votes</dt>
							<dd class="text-3xl font-semibold text-gray-900">{data.stats.votes}</dd>
						</dl>
					</div>
				</div>
			</div>
		</div>
	</div>

	<!-- System Info Grid -->
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-8">
		<!-- System Stats -->
		<div class="bg-white shadow rounded-lg p-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-4">System Information</h2>
			<dl class="space-y-3">
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Uptime</dt>
					<dd class="text-sm font-medium text-gray-900">{formatUptime(data.system.uptime)}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Node.js Version</dt>
					<dd class="text-sm font-medium text-gray-900">{data.system.nodeVersion}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Platform</dt>
					<dd class="text-sm font-medium text-gray-900">{data.system.platform}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Process Memory</dt>
					<dd class="text-sm font-medium text-gray-900">
						{formatBytes(data.system.memory.process.heapUsed)} / {formatBytes(data.system.memory.process.heapTotal)}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">System Memory</dt>
					<dd class="text-sm font-medium text-gray-900">
						{formatBytes(data.system.memory.system.total - data.system.memory.system.free)} / {formatBytes(data.system.memory.system.total)}
					</dd>
				</div>
			</dl>
		</div>

		<!-- Storage Stats -->
		<div class="bg-white shadow rounded-lg p-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-4">Storage</h2>
			<dl class="space-y-3">
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Database Size</dt>
					<dd class="text-sm font-medium text-gray-900">{formatBytes(data.storage.database)}</dd>
				</div>
				<div class="mt-4">
					<a href="/admin/storage" class="text-sm text-blue-600 hover:text-blue-500">
						View detailed storage info →
					</a>
				</div>
			</dl>
		</div>
	</div>

	<!-- Recent Activity Grid -->
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<!-- Recent Users -->
		<div class="bg-white shadow rounded-lg">
			<div class="px-6 py-5 border-b border-gray-200">
				<h2 class="text-lg font-semibold text-gray-900">Recent Users</h2>
			</div>
			<ul class="divide-y divide-gray-200">
				{#each data.recentUsers as user}
					<li class="px-6 py-4">
						<div class="flex items-center justify-between">
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium text-gray-900 truncate">
									{user.name}
								</p>
								<p class="text-sm text-gray-500 truncate">{user.email}</p>
							</div>
							<div class="ml-4 flex-shrink-0">
								<p class="text-xs text-gray-500">{formatDate(user.createdAt)}</p>
							</div>
						</div>
					</li>
				{/each}
			</ul>
			<div class="px-6 py-3 bg-gray-50 text-right">
				<a href="/admin/users" class="text-sm font-medium text-blue-600 hover:text-blue-500">
					View all users →
				</a>
			</div>
		</div>

		<!-- Active Events -->
		<div class="bg-white shadow rounded-lg">
			<div class="px-6 py-5 border-b border-gray-200">
				<h2 class="text-lg font-semibold text-gray-900">Active Events</h2>
			</div>
			<ul class="divide-y divide-gray-200">
				{#each data.activeEvents as event}
					<li class="px-6 py-4">
						<div class="flex items-center justify-between">
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium text-gray-900 truncate">{event.name}</p>
								<p class="text-xs text-gray-500">
									{event._count.groups} groups • {event._count.votes} votes
								</p>
							</div>
							<div class="ml-4 flex-shrink-0">
								<span class="px-2 py-1 text-xs font-semibold rounded {
									event.status === 'live' ? 'bg-green-100 text-green-800' :
									event.status === 'voting' ? 'bg-blue-100 text-blue-800' :
									'bg-gray-100 text-gray-800'
								}">
									{event.status}
								</span>
							</div>
						</div>
					</li>
			{/each}
		</ul>
		<div class="px-6 py-3 bg-gray-50 text-right">
			<a href="/admin/events" class="text-sm font-medium text-blue-600 hover:text-blue-500">
				View all events →
			</a>
		</div>
	</div>
</div>
</PageContainer>
