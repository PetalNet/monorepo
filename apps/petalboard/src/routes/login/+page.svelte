<script lang="ts">
  import type { ActionData } from './$types';

  const { form } = $props<{ form: ActionData | null }>();
  const errors = $derived<Record<string, string[]>>((form?.errors ?? {}) as Record<string, string[]>);
  const values = $derived<Record<string, string>>((form?.values ?? {}) as Record<string, string>);
</script>

<h1 class="mb-2">Log in</h1>
<p class="text-dark-900/75 max-w-[60ch] mb-8">Welcome back! Log in to create and manage your events.</p>

<form method="POST" class="grid gap-6 bg-white p-6 lg:p-10 rounded-[20px] shadow-card w-full max-w-[480px]">
  <label class="form-label text-dark-800">
    <span>Email</span>
    <input type="email" name="email" required value={values.email ?? ''} autocomplete="email" class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18" />
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
      class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18"
    />
    {#if errors.password}
      <small class="text-red-600">{errors.password[0]}</small>
    {/if}
  </label>

  <button type="submit" class="justify-self-start px-7 py-3.5 rounded-full border-none bg-primary-gradient text-white font-semibold cursor-pointer shadow-button hover:-translate-y-px">Log in</button>

  <p class="text-center text-dark-900/70">
    Don't have an account? <a href="/register" class="text-primary-700 font-medium no-underline hover:underline">Create one</a>
  </p>
</form>
