<script lang="ts">
	import { COCKPIT_SKELETON } from "$lib/cockpit-geometry";
</script>

<div class="cockpit-loading" role="status" aria-label="Loading cockpit">
	<span class="sr-only">Loading cockpit</span>
	<div class="chip-row" aria-hidden="true">
		{#each Array(COCKPIT_SKELETON.chips) as _}<span class="chip"></span>{/each}
	</div>
	<div class="ask" aria-hidden="true"><span></span></div>
	<div class="home-grid">
		<section class="town" aria-hidden="true">
			<div class="heading"></div>
			{#each Array(COCKPIT_SKELETON.attentionRows) as _, index}
				<div class="attention">
					<span class="dot"></span>
					<div><span class="line primary" style:width={index === 1 ? "62%" : "72%"}></span><span class="line secondary"></span></div>
				</div>
			{/each}
		</section>
		<aside class="houses" aria-hidden="true">
			<div class="heading short"></div>
			<div class="house-row">
				{#each Array(COCKPIT_SKELETON.houseTiles) as _}
					<div class="house"><span class="roof"></span><span class="body"><i></i><i></i></span><span class="name"></span></div>
				{/each}
			</div>
		</aside>
	</div>
</div>

<style>
	.cockpit-loading { margin-top: var(--s-3); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	.chip-row { display: flex; gap: var(--s-2); flex-wrap: wrap; }
	.chip { width: 116px; height: 32px; border-radius: var(--r-pill); background: var(--s2); }
	.ask { width: min(640px, 100%); height: 48px; margin: var(--s-3) auto; border-radius: var(--r-pill); background: var(--s2); display: flex; align-items: center; padding: 0 var(--s-4); }
	.ask span { width: 42%; height: 8px; background: var(--s3); }
	.home-grid { display: grid; grid-template-columns: 1fr 344px; gap: var(--s-3); margin-top: var(--s-4); }
	.town, .houses { background: var(--s1); border-radius: var(--r-xs); padding: var(--s-3); }
	.heading { width: 144px; height: 12px; margin-bottom: var(--s-2); background: var(--s2); }
	.heading.short { width: 112px; }
	.attention { min-height: 56px; display: grid; grid-template-columns: 16px 1fr; gap: var(--s-2); align-items: center; padding: var(--s-2) var(--s-3); border-top: 1px solid var(--rule); }
	.attention:first-of-type { border-top: 0; }
	.dot { width: 16px; height: 16px; border-radius: 50%; background: var(--s2); }
	.attention > div { display: flex; flex-direction: column; gap: var(--s-2); }
	.line { display: block; height: 8px; background: var(--s2); }
	.line.secondary { width: 42%; height: 6px; }
	.house-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s-2); }
	.house { display: flex; flex-direction: column; align-items: stretch; gap: var(--s-1); }
	.roof { height: 6px; background: var(--s3); border-radius: 2px 2px 0 0; }
	.body { height: 32px; display: flex; justify-content: center; gap: var(--s-1); padding: var(--s-2); background: var(--s2); }
	.body i { width: 7px; height: 9px; background: var(--s3); }
	.name { align-self: center; width: 70%; height: 6px; background: var(--s2); }
	.chip, .ask, .heading, .dot, .line, .roof, .body, .name { animation: skeleton-shift 1.2s ease-in-out infinite alternate; }
	@keyframes skeleton-shift { to { opacity: 0.58; } }
	@media (max-width: 1023px) { .home-grid { grid-template-columns: 1fr; } }
	@media (max-width: 767px) { .houses { display: none; } .chip { flex: 1; min-width: 0; } }
	@media (prefers-reduced-motion: reduce) { .chip, .ask, .heading, .dot, .line, .roof, .body, .name { animation: none; } }
</style>
