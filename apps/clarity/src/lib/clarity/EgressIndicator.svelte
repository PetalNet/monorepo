<script lang="ts">
	interface Egress {
		country_code?: string;
		country_name?: string;
		rotates_in?: string | null;
	}

	let info = $state<Egress | null>(null);
	let open = $state(false);

	// Flag emoji from an ISO-3166 alpha-2 code (regional-indicator letters).
	function flag(cc?: string): string {
		if (cc?.length !== 2) {
			return "🌐";
		}

		const base = 0x1f1e6;
		const up = cc.toUpperCase();

		return String.fromCodePoint(base + (up.charCodeAt(0) - 65), base + (up.charCodeAt(1) - 65));
	}

	async function load() {
		try {
			const r = await fetch("/egress", { headers: { Accept: "application/json" } });

			if (r.ok) {
				info = (await r.json()) as Egress;
			}
		} catch {
			/* keep last-known; the indicator is best-effort */
		}
	}

	$effect(() => {
		load();
		const t = setInterval(load, 120_000); // coarse poll; the timer is coarse anyway

		return () => {
			clearInterval(t);
		};
	});
</script>

{#if info}
	<div class="egress" class:open>
		<button
			class="egress-pill"
			title="Search exit: {info.country_name || 'unknown'} (geolocated from the real exit IP)"
			aria-label="Egress country {info.country_name || 'unknown'}"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			<span class="flag" aria-hidden="true">{flag(info.country_code)}</span>
			<span class="cc">{info.country_code || "··"}</span>
			{#if info.rotates_in}<span class="timer">· ↻ {info.rotates_in}</span>{/if}
		</button>

		{#if open}
			<div class="egress-pop" role="dialog" aria-label="Egress details">
				<div class="row head">
					<span class="flag big" aria-hidden="true">{flag(info.country_code)}</span>
					<div>
						<div class="cname">{info.country_name || "Unknown country"}</div>
						<div class="sub">Exit via Proton · geolocated from the exit IP</div>
					</div>
				</div>
				{#if info.rotates_in}
					<div class="row sub">Rotates in {info.rotates_in} (approximate)</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.egress {
		position: relative;
		display: inline-flex;
	}
	.egress-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--border, rgba(128, 128, 128, 0.28));
		background: var(--surface-2, rgba(128, 128, 128, 0.08));
		color: var(--text, inherit);
		font-size: 0.78rem;
		line-height: 1;
		cursor: pointer;
	}
	.egress-pill:hover {
		background: var(--surface-3, rgba(128, 128, 128, 0.16));
	}
	.flag {
		font-size: 0.95rem;
	}
	.flag.big {
		font-size: 1.6rem;
	}
	.cc {
		font-variant: small-caps;
		letter-spacing: 0.02em;
	}
	.timer {
		opacity: 0.7;
	}
	.egress-pop {
		position: absolute;
		top: calc(100% + 0.4rem);
		right: 0;
		z-index: 60;
		min-width: 15rem;
		padding: 0.7rem 0.8rem;
		border-radius: 0.7rem;
		border: 1px solid var(--border, rgba(128, 128, 128, 0.28));
		background: var(--surface, #1b1b1f);
		color: var(--text, #f0f0f0);
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
		font-size: 0.82rem;
	}
	.row {
		display: flex;
		gap: 0.55rem;
		align-items: center;
	}
	.row.head {
		margin-bottom: 0.4rem;
	}
	.cname {
		font-weight: 600;
	}
	.sub {
		opacity: 0.72;
		font-size: 0.76rem;
	}
</style>
