<script lang="ts">
	import PageContainer from "$lib/components/PageContainer.svelte";
	import PageHeader from "$lib/components/PageHeader.svelte";

	import type { PageData } from "./$types";

	export let data: PageData;

	function formatDate(date: string | Date): string {
		return new Date(date).toLocaleString();
	}
</script>

<svelte:head>
	<title>Events - Admin Panel</title>
</svelte:head>

<PageContainer>
	<PageHeader title="Events" subtitle={`All events in the system. Total: ${data.events.length}`} />

	<div class="overflow-hidden rounded-lg bg-white shadow">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th
						class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
					>
						Event
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
					>
						Host
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
					>
						Status
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
					>
						Stats
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
					>
						Created
					</th>
					<th
						class="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500"
					>
						Actions
					</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200 bg-white">
				{#each data.events as event}
					<tr>
						<td class="whitespace-nowrap px-6 py-4">
							<div>
								<div class="text-sm font-medium text-gray-900">{event.name}</div>
								<div class="text-sm text-gray-500">Code: {event.joinCode}</div>
							</div>
						</td>
						<td class="whitespace-nowrap px-6 py-4">
							<div class="text-sm text-gray-900">{event.host.name}</div>
							<div class="text-sm text-gray-500">{event.host.email}</div>
						</td>
						<td class="whitespace-nowrap px-6 py-4">
							<span
								class="inline-flex rounded-full px-2 text-xs font-semibold leading-5 {event.status ===
								'live'
									? 'bg-green-100 text-green-800'
									: event.status === 'voting'
										? 'bg-blue-100 text-blue-800'
										: event.status === 'completed'
											? 'bg-gray-100 text-gray-800'
											: 'bg-yellow-100 text-yellow-800'}"
							>
								{event.status}
							</span>
						</td>
						<td class="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
							{event._count.groups} groups •
							{event._count.votes} votes •
							{event._count.judges} judges
						</td>
						<td class="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
							{formatDate(event.createdAt)}
						</td>
						<td class="whitespace-nowrap px-6 py-4 text-right text-sm font-medium">
							<a href="/event/{event.id}" class="text-blue-600 hover:text-blue-900" target="_blank">
								View
							</a>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</PageContainer>
