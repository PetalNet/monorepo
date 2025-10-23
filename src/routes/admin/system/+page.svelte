<script lang="ts">
	import type { PageData } from './$types';
	
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
		const secs = Math.floor(seconds % 60);
		
		if (days > 0) return `${days}d ${hours}h ${minutes}m ${secs}s`;
		if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
		if (minutes > 0) return `${minutes}m ${secs}s`;
		return `${secs}s`;
	}
	
	function getMemoryPercentage(used: number, total: number): number {
		return Math.round((used / total) * 100);
	}
</script>

<svelte:head>
	<title>System - Admin Panel</title>
</svelte:head>

<div class="px-4 py-6">
	<h1 class="text-3xl font-bold text-gray-900 mb-8">System Information</h1>

	<!-- Process Info -->
	<div class="bg-white shadow rounded-lg p-6 mb-6">
		<h2 class="text-lg font-semibold text-gray-900 mb-4">Process Information</h2>
		<dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<div>
				<dt class="text-sm text-gray-500">Process ID</dt>
				<dd class="text-sm font-medium text-gray-900">{data.process.pid}</dd>
			</div>
			<div>
				<dt class="text-sm text-gray-500">Uptime</dt>
				<dd class="text-sm font-medium text-gray-900">{formatUptime(data.process.uptime)}</dd>
			</div>
			<div>
				<dt class="text-sm text-gray-500">Node.js Version</dt>
				<dd class="text-sm font-medium text-gray-900">{data.process.nodeVersion}</dd>
			</div>
			<div>
				<dt class="text-sm text-gray-500">Platform</dt>
				<dd class="text-sm font-medium text-gray-900">{data.process.platform} ({data.process.arch})</dd>
			</div>
		</dl>
	</div>

	<!-- Memory Usage -->
	<div class="bg-white shadow rounded-lg p-6 mb-6">
		<h2 class="text-lg font-semibold text-gray-900 mb-4">Memory Usage</h2>
		
		<div class="mb-6">
			<h3 class="text-sm font-medium text-gray-700 mb-2">Process Memory</h3>
			<div class="space-y-2">
				<div>
					<div class="flex justify-between text-sm mb-1">
						<span class="text-gray-600">Heap Used</span>
						<span class="font-medium">{formatBytes(data.process.memory.heapUsed)} / {formatBytes(data.process.memory.heapTotal)}</span>
					</div>
					<div class="w-full bg-gray-200 rounded-full h-2">
						<div 
							class="bg-blue-600 h-2 rounded-full" 
							style="width: {getMemoryPercentage(data.process.memory.heapUsed, data.process.memory.heapTotal)}%"
						></div>
					</div>
				</div>
				<div class="grid grid-cols-2 gap-4 text-sm pt-2">
					<div>
						<dt class="text-gray-500">RSS</dt>
						<dd class="font-medium text-gray-900">{formatBytes(data.process.memory.rss)}</dd>
					</div>
					<div>
						<dt class="text-gray-500">External</dt>
						<dd class="font-medium text-gray-900">{formatBytes(data.process.memory.external)}</dd>
					</div>
				</div>
			</div>
		</div>

		<div>
			<h3 class="text-sm font-medium text-gray-700 mb-2">System Memory</h3>
			<div>
				<div class="flex justify-between text-sm mb-1">
					<span class="text-gray-600">Used</span>
					<span class="font-medium">
						{formatBytes(data.system.memory.total - data.system.memory.free)} / {formatBytes(data.system.memory.total)}
					</span>
				</div>
				<div class="w-full bg-gray-200 rounded-full h-2">
					<div 
						class="bg-green-600 h-2 rounded-full" 
						style="width: {getMemoryPercentage(data.system.memory.total - data.system.memory.free, data.system.memory.total)}%"
					></div>
				</div>
			</div>
		</div>
	</div>

	<!-- System Info -->
	<div class="bg-white shadow rounded-lg p-6 mb-6">
		<h2 class="text-lg font-semibold text-gray-900 mb-4">System Information</h2>
		<dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<div>
				<dt class="text-sm text-gray-500">Hostname</dt>
				<dd class="text-sm font-medium text-gray-900">{data.system.hostname}</dd>
			</div>
			<div>
				<dt class="text-sm text-gray-500">OS Type</dt>
				<dd class="text-sm font-medium text-gray-900">{data.system.type}</dd>
			</div>
			<div>
				<dt class="text-sm text-gray-500">OS Release</dt>
				<dd class="text-sm font-medium text-gray-900">{data.system.release}</dd>
			</div>
			<div>
				<dt class="text-sm text-gray-500">CPU Cores</dt>
				<dd class="text-sm font-medium text-gray-900">{data.system.cpus}</dd>
			</div>
			<div class="sm:col-span-2">
				<dt class="text-sm text-gray-500">Load Average (1m, 5m, 15m)</dt>
				<dd class="text-sm font-medium text-gray-900">
					{data.system.loadavg.map(l => l.toFixed(2)).join(', ')}
				</dd>
			</div>
		</dl>
	</div>

	<!-- Environment -->
	<div class="bg-white shadow rounded-lg p-6">
		<h2 class="text-lg font-semibold text-gray-900 mb-4">Environment</h2>
		<dl class="space-y-3">
			<div class="flex justify-between">
				<dt class="text-sm text-gray-500">NODE_ENV</dt>
				<dd class="text-sm font-medium text-gray-900">
					<span class="px-2 py-1 rounded {data.environment.nodeEnv === 'production' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}">
						{data.environment.nodeEnv}
					</span>
				</dd>
			</div>
			<div class="flex justify-between">
				<dt class="text-sm text-gray-500">Port</dt>
				<dd class="text-sm font-medium text-gray-900">{data.environment.port}</dd>
			</div>
			<div class="flex justify-between">
				<dt class="text-sm text-gray-500">Database URL</dt>
				<dd class="text-xs font-medium text-gray-900 font-mono truncate ml-4">
					{data.environment.databaseUrl}
				</dd>
			</div>
		</dl>
	</div>
</div>
