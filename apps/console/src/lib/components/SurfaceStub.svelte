<script lang="ts">
	import Icon from "./Icon.svelte";
	import SurfaceSign from "./SurfaceSign.svelte";

	/**
	 * Honest placeholder for a surface whose full build lands in its own PR. Not a
	 * facade: it says plainly that this curated dashboard is on the way and that
	 * the ask box already works. The shell (nav, session, state line, quick-nav)
	 * is fully live around it.
	 */
	interface Props {
		title: string;
		icon: string;
		sign?: string | null;
		blurb: string;
	}
	let { title, icon, sign = null, blurb }: Props = $props();
</script>

<SurfaceSign {title} />

<div class="stub">
	<div class="mark"><Icon name={icon} size={22} /></div>
	{#if sign}<div class="sign">{sign}</div>{/if}
	<p class="blurb">{blurb}</p>
	<p class="note">This curated dashboard ships in its own surface PR. Ask Janet anything meanwhile.</p>
</div>

<style>
	.stub {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--s-2);
		text-align: center;
		padding: var(--s-6) var(--s-4);
		color: var(--text-3);
	}
	.mark {
		width: 44px;
		height: 44px;
		border-radius: var(--r-sm);
		background: var(--s1);
		display: grid;
		place-items: center;
		color: var(--jade);
	}
	.sign {
		font:
			400 1.0625rem var(--sign);
		color: var(--text-2);
	}
	.blurb {
		font-size: 0.8125rem;
		max-width: 44ch;
	}
	.note {
		font-size: 0.75rem;
		color: var(--text-3);
		max-width: 40ch;
	}
</style>
