<script lang="ts">
	let {
		message,
		error = false,
		dismiss,
	}: { message: string; error?: boolean; dismiss?: () => void } = $props();
	let toast = $state<HTMLDivElement>();
	$effect(() => {
		if (message && toast) {
			toast.showPopover();
		}
	});
</script>

{#if message}
	<div
		bind:this={toast}
		popover="manual"
		class="toast toast-start m-0 max-w-[calc(100vw-2rem)] border-0 bg-transparent"
	>
		<div
			class="alert bg-base-300 shadow-md"
			class:text-error={error}
			role={error ? "alert" : "status"}
		>
			<span>{message}</span>
			{#if dismiss}<button class="btn btn-ghost btn-sm" onclick={dismiss}>Dismiss</button>{/if}
		</div>
	</div>
{/if}
