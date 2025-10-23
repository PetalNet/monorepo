<script lang="ts">
	import type { PageData } from './$types';
	
	export let data: PageData;
	
	function formatDate(date: string | Date): string {
		return new Date(date).toLocaleString();
	}
</script>

<svelte:head>
	<title>Events - Admin Panel</title>
</svelte:head>

<div class="px-4 py-6">
	<div class="sm:flex sm:items-center mb-6">
		<div class="sm:flex-auto">
			<h1 class="text-3xl font-bold text-gray-900">Events</h1>
			<p class="mt-2 text-sm text-gray-700">
				All events in the system. Total: {data.events.length}
			</p>
		</div>
	</div>

	<div class="bg-white shadow rounded-lg overflow-hidden">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
						Event
					</th>
					<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
						Host
					</th>
					<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
						Status
					</th>
					<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
						Stats
					</th>
					<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
						Created
					</th>
					<th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
						Actions
					</th>
				</tr>
			</thead>
			<tbody class="bg-white divide-y divide-gray-200">
				{#each data.events as event}
					<tr>
						<td class="px-6 py-4 whitespace-nowrap">
							<div>
								<div class="text-sm font-medium text-gray-900">{event.name}</div>
								<div class="text-sm text-gray-500">Code: {event.joinCode}</div>
							</div>
						</td>
						<td class="px-6 py-4 whitespace-nowrap">
							<div class="text-sm text-gray-900">{event.host.name}</div>
							<div class="text-sm text-gray-500">{event.host.email}</div>
						</td>
						<td class="px-6 py-4 whitespace-nowrap">
							<span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full {
								event.status === 'live' ? 'bg-green-100 text-green-800' :
								event.status === 'voting' ? 'bg-blue-100 text-blue-800' :
								event.status === 'completed' ? 'bg-gray-100 text-gray-800' :
								'bg-yellow-100 text-yellow-800'
							}">
								{event.status}
							</span>
						</td>
						<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
							{event._count.groups} groups •
							{event._count.votes} votes •
							{event._count.judges} judges
						</td>
						<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
							{formatDate(event.createdAt)}
						</td>
						<td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
							<a
								href="/event/{event.id}"
								class="text-blue-600 hover:text-blue-900"
								target="_blank"
							>
								View
							</a>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
