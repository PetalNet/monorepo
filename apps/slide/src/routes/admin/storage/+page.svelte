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
</script>

<svelte:head>
	<title>Storage - Admin Panel</title>
</svelte:head>

<PageContainer>
	<PageHeader 
		title="Storage Information"
		subtitle="Database and file storage details"
	/>

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-8">
		<!-- Database Info -->
		<div class="bg-white shadow rounded-lg p-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-4">Database</h2>
			<dl class="space-y-3">
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Path</dt>
					<dd class="text-sm font-medium text-gray-900 font-mono truncate ml-4">
						{data.database.path}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Total Size</dt>
					<dd class="text-sm font-medium text-gray-900">
						{formatBytes(data.database.size)}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Total Records</dt>
					<dd class="text-sm font-medium text-gray-900">
						{data.database.totalRecords.toLocaleString()}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Estimated Data</dt>
					<dd class="text-sm font-medium text-gray-900">
						{formatBytes(data.database.estimatedDataSize)}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-sm text-gray-500">Overhead/Index</dt>
					<dd class="text-sm font-medium text-gray-900">
						{formatBytes(Math.max(0, data.database.overhead))}
					</dd>
				</div>
			</dl>
		</div>

		<!-- Record Counts -->
		<div class="bg-white shadow rounded-lg p-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-4">Records by Table</h2>
			<dl class="space-y-3">
				{#each Object.entries(data.database.recordCounts) as [table, count]}
					<div class="flex justify-between">
						<dt class="text-sm text-gray-500 capitalize">{table}</dt>
						<dd class="text-sm font-medium text-gray-900">
							{count.toLocaleString()}
						</dd>
					</div>
				{/each}
			</dl>
		</div>
	</div>

	<!-- Storage Tips -->
	<div class="bg-blue-50 border border-blue-200 rounded-lg p-6">
		<h3 class="text-sm font-semibold text-blue-900 mb-2">💡 Storage Tips</h3>
		<ul class="text-sm text-blue-800 space-y-1 list-disc list-inside">
			<li>Regular backups are recommended when database size exceeds 100 MB</li>
			<li>Consider archiving completed events to reduce database size</li>
			<li>Monitor storage growth over time to plan for scaling</li>
			<li>SQLite performs best with databases under 1 GB</li>
		</ul>
	</div>
</PageContainer>
