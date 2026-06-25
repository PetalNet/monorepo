<script lang="ts">
  import type { ActionData } from './$types';

  const { form } = $props<{ form: ActionData | null }>();
  const errors = $derived<Record<string, string[]>>((form?.errors ?? {}) as Record<string, string[]>);
  const values = $derived<Record<string, string>>((form?.values ?? {}) as Record<string, string>);
  const message = $derived<string | null>(form?.message ?? null);
  const success = $derived<boolean>(form?.success ?? false);
</script>

<h1 class="mb-2">Create an account</h1>
<p class="text-dark-900/75 max-w-[60ch] mb-8">
  Register to create and manage your own events. Your guests don't need accounts to sign up.
</p>

{#if success}
  <div class="bg-primary-500/12 rounded-[20px] p-8 max-w-[480px] mb-8">
    <h2 class="text-dark-600 mt-0 mb-2">Check your email!</h2>
    <p class="text-dark-900/85 m-0">{message}</p>
  </div>
{:else}
  {#if message}
    <p class="bg-red-500/12 rounded-2xl px-4 py-3 text-red-900 max-w-[480px] mb-6">{message}</p>
  {/if}

  <form method="POST" class="grid gap-6 bg-white p-6 lg:p-10 rounded-[20px] shadow-card w-full max-w-[480px]">
    <label class="form-label text-dark-800">
      <span>Name</span>
      <input name="name" required value={values.name ?? ''} autocomplete="name" class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18" />
      {#if errors.name}
        <small class="text-red-600">{errors.name[0]}</small>
      {/if}
    </label>

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
        minlength="8"
        autocomplete="new-password"
        class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18"
      />
      {#if errors.password}
        <small class="text-red-600">{errors.password[0]}</small>
      {/if}
    </label>

    <button type="submit" class="justify-self-start px-7 py-3.5 rounded-full border-none bg-primary-gradient text-white font-semibold cursor-pointer shadow-button hover:-translate-y-px">Create account</button>

    <p class="text-center text-dark-900/70">
      Already have an account? <a href="/login" class="text-primary-700 font-medium no-underline hover:underline">Log in</a>
    </p>
  </form>
{/if}
