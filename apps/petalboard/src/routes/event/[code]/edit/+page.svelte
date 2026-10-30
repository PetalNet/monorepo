<script lang="ts">
	import { applyEventTheme, eventTheme, withAlpha } from "$lib/eventTheme";

	import type { ActionData, PageData } from "./$types";

	const { data, form }: { data: PageData; form: ActionData | null } = $props();
	const theme = $derived(eventTheme(data.event));
	const gradient = (stop: 700 | 800) =>
		`linear-gradient(135deg, ${theme.primaryColors[stop]}, ${theme.secondaryColors[stop]})`;

	$effect(() => applyEventTheme(theme.themeVars, data.event));
</script>

<svelte:head>
	<title>Edit your RSVP - {data.event.title} - PetalBoard</title>
	<meta name="referrer" content="same-origin" />
</svelte:head>

<div class="mx-auto max-w-[480px] px-4 py-12">
	<section class="card text-center" aria-labelledby="edit-link-title">
		<h1 id="edit-link-title" class="mb-4 text-2xl font-bold">
			Edit your RSVP for {data.event.title}
		</h1>

		{#if form?.expired}
			<p class="mb-6 text-dark-700" role="alert">
				This link expired or was already used. Links work once, for 1 hour.
			</p>
			<a
				class="btn-secondary inline-flex min-h-11 items-center"
				href="/event/{data.event.publicCode}">Back to the event to get a new link</a
			>
		{:else}
			<p class="mb-6 text-dark-700">Continue to open your RSVP on this browser.</p>
			<form method="POST">
				<input type="hidden" name="token" value={data.token} />
				<button
					type="submit"
					class="min-h-11 w-full rounded-xl px-6 py-3 text-base font-semibold text-white shadow-button transition-colors md:w-auto md:px-8"
					style={`background: ${gradient(700)}; box-shadow: 0 14px 28px ${withAlpha(theme.primaryColors[600], 0.33)};`}
					onmouseover={(e) => (e.currentTarget.style.background = gradient(800))}
					onmouseout={(e) => (e.currentTarget.style.background = gradient(700))}
					onfocus={(e) => (e.currentTarget.style.background = gradient(800))}
					onblur={(e) => (e.currentTarget.style.background = gradient(700))}>Continue</button
				>
			</form>
		{/if}
	</section>
</div>
