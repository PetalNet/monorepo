<section class="grid gap-12 grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] items-center">
  <div>
    <h1 class="text-[clamp(2.6rem,5vw,3.6rem)] leading-tight mb-6 font-bold bg-gradient-to-br from-dark-800 to-primary-800 bg-clip-text text-transparent">Signup lists your guests will actually love using.</h1>
    <p class="text-lg max-w-[38ch] text-dark-900/80 leading-relaxed">
      PetalBoard helps hosts organize events, and keep guests in the
      loop without requiring accounts.
    </p>
    <div class="flex gap-4 mt-8 flex-wrap">
      <a class="inline-flex items-center justify-center px-7 py-3.5 rounded-full no-underline font-semibold transition-all hover:-translate-y-0.5 hover:shadow-2xl bg-primary-gradient text-white shadow-button" href="/create">Create an event</a>
    </div>
  </div>
  <div class="bg-white rounded-[20px] p-8 shadow-card-hover border border-primary-700/5 transition-all hover:shadow-2xl hover:-translate-y-1">
    <p class="font-semibold text-dark-500 mb-4 flex items-center gap-2">
      <span class="text-2xl">✨</span>
      Instant overview
    </p>
    <ul class="pl-5 grid gap-2 text-dark-700">
      <li>Track remaining slots in real time</li>
      <li>Share public and manage links with one click</li>
      <li>Secure edits with a PIN instead of passwords</li>
    </ul>
  </div>
</section>

<section class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-6 mt-16">
  <article class="bg-white rounded-[18px] p-8 shadow-[0_18px_32px_rgba(66,32,121,0.08)] border border-primary-700/5 transition-all hover:shadow-2xl hover:-translate-y-1">
    <h2 class="mt-0 flex items-center gap-2 text-primary-700">
      <span class="text-2xl">🎯</span>
      Organizers
    </h2>
    <p class="text-dark-700">Create an event, add slots, and share the link—done.</p>
    <ul class="pl-5 grid gap-2 text-dark-700">
      <li>Edit event details any time</li>
      <li>Prevent overbooking with server-side checks</li>
      <li>Print an attendee list in a couple taps</li>
    </ul>
  </article>
  <article class="bg-white rounded-[18px] p-8 shadow-[0_18px_32px_rgba(66,32,121,0.08)] border border-primary-700/5 transition-all hover:shadow-2xl hover:-translate-y-1">
    <h2 class="mt-0 flex items-center gap-2 text-primary-700">
      <span class="text-2xl">👥</span>
      Guests
    </h2>
    <p class="text-dark-700">No accounts. Just pick a slot, add your name, and choose a PIN.</p>
    <ul class="pl-5 grid gap-2 text-dark-700">
      <li>Mobile-first sign up experience</li>
      <li>Make changes later with your signup ID</li>
      <li>Automatic email reminders (coming soon)</li>
    </ul>
  </article>
  <article class="bg-white rounded-[18px] p-8 shadow-[0_18px_32px_rgba(66,32,121,0.08)] border border-primary-700/5 transition-all hover:shadow-2xl hover:-translate-y-1">
    <h2 class="mt-0 flex items-center gap-2 text-primary-700">
      <span class="text-2xl">🔒</span>
      Built for real life
    </h2>
    <p class="text-dark-700">All data stays private to your event. No ads, no dark patterns.</p>
    <ul class="pl-5 grid gap-2 text-dark-700">
      <li>SQLite by default, Postgres-ready for production</li>
      <li>Scrypt hashed PINs for secure edit links</li>
      <li>Open source and ready to self-host</li>
    </ul>
  </article>
</section>

<section class="mt-20 grid gap-8 grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-center">
  <div>
    <h2 class="text-3xl font-bold mb-4 text-dark-800">How it works</h2>
    <ol class="pl-5 grid gap-3 text-dark-700 text-lg">
      <li class="pl-2"><strong>Create an event</strong> and add the items you need.</li>
      <li class="pl-2"><strong>Share the public link</strong> with your guests.</li>
      <li class="pl-2"><strong>Guests reserve their slot</strong> and lock it with a PIN.</li>
      <li class="pl-2"><strong>They can edit or cancel</strong> later with their signup ID.</li>
    </ol>
  </div>
  <div class="bg-gradient-to-br from-primary-700/15 to-accent-500/20 rounded-[24px] p-10 shadow-xl border border-primary-700/10 hover:shadow-2xl transition-all">
    <h3 class="mt-0 text-2xl font-bold text-dark-800 mb-3">Ready to go? 🚀</h3>
    <p class="text-dark-700 mb-4 leading-relaxed">PetalBoard is fully open source.</p>
    <a
      class="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-full no-underline font-semibold transition-all hover:-translate-y-0.5 hover:shadow-2xl bg-white text-primary-700 border border-primary-500/40 shadow-sm"
      href="https://github.com/petalcat/petalboard"
      target="_blank"
      rel="noreferrer"
    >
      <span>Explore the GitHub repo</span>
      <span aria-hidden="true" class="text-lg">↗</span>
    </a>
    <a
      class="mt-4 inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-full no-underline font-semibold transition-all hover:-translate-y-0.5 hover:shadow-2xl bg-primary-gradient text-white shadow-button"
      href="/create"
    >
      <span>Launch the hosted builder</span>
      <span aria-hidden="true" class="text-lg">→</span>
    </a>
    <p class="text-xs text-dark-600 mt-3">
      Prefer writing code? Fork the repo. Want the hosted experience? Jump straight into the builder.
    </p>
  </div>
</section>
