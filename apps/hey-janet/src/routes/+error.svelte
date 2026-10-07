<script lang="ts">
	import { resolve } from "$app/paths";
	import { page } from "$app/state";
</script>

<svelte:head><title>Let’s try again · Hey Janet</title></svelte:head>
<main class="mx-auto max-w-3xl p-4 sm:p-6">
	<a
		class="text-base-content flex items-center gap-2 font-semibold no-underline"
		href={resolve("/")}>Hey Janet</a
	>
	<section class="max-w-xl pt-8 pb-6">
		<h1>{page.status === 403 ? "This part is for Parker." : "We couldn’t finish that."}</h1>
		<p>
			{page.error?.message ?? "Please try again. Your accepted takes remain saved on your device."}
		</p>
		<div class="flex flex-wrap items-center gap-4">
			<a class="btn btn-primary min-h-12 border-0 shadow-none" href={resolve("/")}
				>Return to the booth</a
			>{#if page.status === 403}<a
					class="btn bg-base-100 text-base-content min-h-12 border-0 shadow-none"
					href={resolve("/auth/login")}>Sign in with PetalNet</a
				>{/if}
		</div>
	</section>
</main>
