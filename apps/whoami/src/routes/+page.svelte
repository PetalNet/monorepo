<script lang="ts">
	import { collectSignals, CATEGORY_LABELS, type Signal, type SignalCategory } from "$lib/collect";

	let signals = $state<Signal[]>([]);
	let ready = $state(false);

	$effect(() => {
		let alive = true;
		collectSignals().then((s) => {
			if (alive) {
				signals = s;
				ready = true;
			}
		});
		return () => {
			alive = false;
		};
	});

	const grouped = $derived.by(() => {
		const map = new Map<SignalCategory, Signal[]>();
		for (const s of signals) {
			const arr = map.get(s.category) ?? [];
			arr.push(s);
			map.set(s.category, arr);
		}
		return [...map.entries()];
	});

	const revealed = $derived(signals.length);
	const strong = $derived(signals.filter((s) => s.weight >= 3).length);

	function weightLabel(w: number): string {
		return w >= 3 ? "STRONG" : w === 2 ? "MODERATE" : w === 1 ? "MINOR" : "TRIVIAL";
	}
</script>

<main>
	<header>
		<h1>whoami</h1>
		<p class="tag">Everything your browser just told this page — without asking you.</p>
		<p class="sub">
			Nothing here is sent anywhere or stored. This runs in your browser and shows you the same
			signals a tracker reads silently. The point isn't a score. It's the inventory: what leaks, and
			how much.
		</p>
	</header>

	{#if !ready}
		<p class="loading">reading signals…</p>
	{:else}
		<div class="counts">
			<div class="count">
				<span class="n">{revealed}</span><span class="l">signals read</span>
			</div>
			<div class="count">
				<span class="n">{strong}</span><span class="l">strongly identifying</span>
			</div>
		</div>

		{#each grouped as [category, items] (category)}
			<section>
				<h2>{CATEGORY_LABELS[category]}</h2>
				<div class="rows">
					{#each items as sig (sig.id)}
						<div class="row" data-weight={sig.weight}>
							<div class="head">
								<span class="label">{sig.label}</span>
								<span class="badge">{weightLabel(sig.weight)}</span>
							</div>
							<div class="value">{sig.value}</div>
							<div class="note">{sig.note}</div>
						</div>
					{/each}
				</div>
			</section>
		{/each}
	{/if}

	<footer>
		<p>
			Read-only. No storage, no logs, no network. Want to shrink this list? The audit (coming next)
			checks your about:config against the fingerprinting trade-offs.
		</p>
	</footer>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #05070a;
		color: #7dfba0;
		font-family: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	}
	main {
		max-width: 60rem;
		margin-inline: auto;
		padding: 2.5rem 1.25rem 4rem;
	}
	header h1 {
		font-size: clamp(2.5rem, 8vw, 4.5rem);
		margin: 0;
		letter-spacing: -0.03em;
		color: #8affb0;
		text-shadow:
			0 0 12px rgba(80, 255, 150, 0.55),
			0 0 2px rgba(80, 255, 150, 0.9);
	}
	.tag {
		font-size: 1.15rem;
		color: #ffd166;
		margin: 0.35rem 0 0;
		text-shadow: 0 0 8px rgba(255, 200, 80, 0.4);
	}
	.sub {
		color: #5b9c72;
		max-width: 46rem;
		line-height: 1.55;
	}
	.loading {
		color: #ffd166;
		font-size: 1.1rem;
	}
	.counts {
		display: flex;
		gap: 1.5rem;
		margin: 1.5rem 0 2rem;
		flex-wrap: wrap;
	}
	.count {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		border: 1px solid #16351f;
		background: #08110b;
		padding: 0.75rem 1.1rem;
	}
	.count .n {
		font-size: 2rem;
		color: #8affb0;
		font-variant-numeric: tabular-nums;
		text-shadow: 0 0 10px rgba(80, 255, 150, 0.5);
	}
	.count .l {
		color: #5b9c72;
		text-transform: uppercase;
		font-size: 0.75rem;
		letter-spacing: 0.08em;
	}
	section {
		margin-bottom: 2rem;
	}
	h2 {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: #ffd166;
		border-bottom: 1px solid #16351f;
		padding-bottom: 0.4rem;
		margin: 0 0 0.9rem;
	}
	.rows {
		display: grid;
		gap: 0.6rem;
	}
	.row {
		border: 1px solid #123019;
		background: #070d09;
		padding: 0.7rem 0.9rem;
	}
	.row[data-weight="3"] {
		border-color: #5a1c1c;
		background: #0d0807;
	}
	.row[data-weight="2"] {
		border-color: #4a3f1a;
		background: #0c0b07;
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
	}
	.label {
		color: #b8ffce;
		font-weight: 600;
	}
	.badge {
		font-size: 0.65rem;
		letter-spacing: 0.1em;
		color: #5b9c72;
		border: 1px solid #16351f;
		padding: 0.1rem 0.4rem;
	}
	.row[data-weight="3"] .badge {
		color: #ff8f8f;
		border-color: #5a1c1c;
	}
	.row[data-weight="2"] .badge {
		color: #ffd166;
		border-color: #5a4a1c;
	}
	.value {
		color: #eafff0;
		word-break: break-word;
		margin: 0.35rem 0;
		font-size: 0.95rem;
	}
	.note {
		color: #5b9c72;
		font-size: 0.82rem;
		line-height: 1.45;
	}
	footer {
		margin-top: 2.5rem;
		border-top: 1px solid #16351f;
		padding-top: 1rem;
		color: #4a7a5c;
		font-size: 0.85rem;
	}
	@media (prefers-reduced-motion: reduce) {
		* {
			text-shadow: none !important;
		}
	}
</style>
