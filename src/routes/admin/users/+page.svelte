<script lang="ts">
	import type { PageData } from './$types';
	import { enhance } from '$app/forms';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	
	export let data: PageData;
	
	function formatDate(date: string | Date): string {
		return new Date(date).toLocaleString();
	}
	
	let deletingUserId: string | null = null;
	
	function confirmDelete(userId: string) {
		deletingUserId = userId;
	}
	
	function isAdmin(email: string): boolean {
		return email === data.adminEmail;
	}
</script>

<svelte:head>
	<title>Users - Admin Panel</title>
</svelte:head>

<PageContainer>
	<PageHeader 
		title="Users"
		subtitle={`Manage all users in the system. Total: ${data.users.length}`}
	/>

	<div class="bg-white shadow rounded-lg overflow-hidden">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
						User
					</th>
					<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
						Role
					</th>
					<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
						Activity
					</th>
					<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
						Joined
					</th>
					<th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
						Actions
					</th>
				</tr>
			</thead>
			<tbody class="bg-white divide-y divide-gray-200">
				{#each data.users as user}
					<tr>
						<td class="px-6 py-4 whitespace-nowrap">
							<div>
								<div class="text-sm font-medium text-gray-900">{user.name}</div>
								<div class="text-sm text-gray-500">{user.email}</div>
							</div>
						</td>
						<td class="px-6 py-4 whitespace-nowrap">
							{#if isAdmin(user.email)}
								<span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800">
									Admin
								</span>
							{:else}
								<span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-800">
									User
								</span>
							{/if}
						</td>
						<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
							{user._count.hostedEvents} events •
							{user._count.groupMembers} groups •
							{user._count.votes} votes
						</td>
						<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
							{formatDate(user.createdAt)}
						</td>
						<td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
							{#if deletingUserId === user.id}
								<form method="POST" action="?/deleteUser" use:enhance class="inline">
									<input type="hidden" name="userId" value={user.id} />
									<button
										type="submit"
										class="text-red-600 hover:text-red-900 mr-2"
									>
										Confirm Delete
									</button>
									<button
										type="button"
										on:click={() => deletingUserId = null}
										class="text-gray-600 hover:text-gray-900"
									>
										Cancel
									</button>
								</form>
							{:else if !isAdmin(user.email)}
								<button
									on:click={() => confirmDelete(user.id)}
									class="text-red-600 hover:text-red-900"
							>
								Delete
							</button>
						{:else}
							<span class="text-gray-400">Protected</span>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
</PageContainer>
