<script lang="ts">
	import type { ActionData } from "./$types";

	const { form } = $props<{ form: ActionData | null }>();
	const errors = $derived<Record<string, string[]>>(
		(form?.errors ?? {}) as Record<string, string[]>,
	);
	const values = $derived<Record<string, string>>((form?.values ?? {}) as Record<string, string>);
</script>

<h1 class="mb-2">Log in</h1>
<p class="mb-8 max-w-[60ch] text-dark-900/75">
	Welcome back! Log in to create and manage your events.
</p>

<form
	method="POST"
	class="grid w-full max-w-[480px] gap-6 rounded-[20px] bg-white p-6 shadow-card lg:p-10"
>
	<label class="form-label text-dark-800">
		<span>Email</span>
		<input
			type="email"
			name="email"
			required
			value={values.email ?? ""}
			autocomplete="email"
			class="font-inherit focus:ring-primary-700/18 rounded-xl border border-primary-700/25 bg-white/90 px-4 py-3 focus:border-primary-700 focus:outline-none focus:ring-4"
		/>
		{#if errors.email}
			<small class="text-red-600">{errors.email[0]}</small>
		{/if}
	</label>

	<label class="form-label text-dark-800">
		<span>Password</span>
		<input
			type="password"
			name="password"
			required
			autocomplete="current-password"
			class="font-inherit focus:ring-primary-700/18 rounded-xl border border-primary-700/25 bg-white/90 px-4 py-3 focus:border-primary-700 focus:outline-none focus:ring-4"
		/>
		{#if errors.password}
			<small class="text-red-600">{errors.password[0]}</small>
		{/if}
	</label>

	<button
		type="submit"
		class="cursor-pointer justify-self-start rounded-full border-none bg-primary-gradient px-7 py-3.5 font-semibold text-white shadow-button hover:-translate-y-px"
		>Log in</button
	>

	<p class="text-center text-dark-900/70">
		Don't have an account? <a
			href="/register"
			class="font-medium text-primary-700 no-underline hover:underline">Create one</a
		>
	</p>
</form>
