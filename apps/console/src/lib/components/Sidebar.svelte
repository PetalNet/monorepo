<script lang="ts">
	import { page } from "$app/state";
	import type { HealthVerdict } from "$lib/api/derive";
	import type { Me } from "$lib/api/types";
	import { visibleNav } from "$lib/nav";
	import { initial } from "$lib/util";
	import Icon from "./Icon.svelte";
	import StatusDot from "./StatusDot.svelte";

	/** Sidebar (foundations §2.2). Footer state line carries the three-way truth
	 * on every screen: fine / crack fact / "Can't verify" (§4.6). */
	interface Props {
		me: Me;
		verdict: HealthVerdict;
		/** The fact line for crack (first P0 summary) or "Bus silent Nm." for can't-verify. */
		stateFact?: string | null;
		/** Per-href badge values: number => count; "down"/"p0" => danger dot. */
		badges?: Record<string, number | "down" | "p0" | null>;
	}
	let { me, verdict, stateFact = null, badges = {} }: Props = $props();

	const nav = $derived(visibleNav(me.lanes));
	const current = $derived(page.url.pathname);

	function isActive(href: string): boolean {
		return href === "/" ? current === "/" : current.startsWith(href);
	}
</script>

<aside class="sb">
	<div class="sb-brand">
		<div class="sb-mark" aria-hidden="true"></div>
		<div class="sb-name">the neighborhood<small>12358W</small></div>
	</div>

	<nav aria-label="Surfaces">
		{#each nav as item (item.href)}
			{@const badge = badges[item.href]}
			<a class="nav-item" class:active={isActive(item.href)} href={item.href} title={item.sign}>
				<Icon name={item.icon} size={16} />
				<span class="nav-label">{item.label}</span>
				{#if typeof badge === "number"}
					<span class="nav-badge">{badge}</span>
				{:else if badge === "down" || badge === "p0"}
					<StatusDot tone="danger" size={6} />
				{/if}
			</a>
		{/each}
	</nav>

	<div class="sb-foot">
		<div class="sb-user">
			<span class="sb-ava">{initial(me.display_name ?? me.id)}</span>
			<span class="who"><b>{me.display_name ?? me.id}</b><span class="handle">@{me.id}</span></span>
		</div>
		<div class="sb-session">
			<Icon name="sparkles" size={12} />
			Your Janet · scope: {me.grant_name ?? me.id} · live
		</div>
		<div class="sb-state {verdict}">
			{#if verdict === "cracked"}
				<Icon name="triangle-alert" size={12} />
				<span>{stateFact ?? "Everything is not fine."}</span>
			{:else if verdict === "cant_verify"}
				<Icon name="circle-help" size={12} />
				<span>{stateFact ?? "Can't verify."}</span>
			{:else if verdict === "needs_you"}
				<Icon name="circle-check" size={12} />
				<span>Mostly fine. Something needs you.</span>
			{:else}
				<Icon name="circle-check" size={12} />
				<span>Welcome! Everything is fine.</span>
			{/if}
		</div>
	</div>
</aside>

<style>
	.sb {
		background: var(--s1);
		border-inline-end: 1px solid var(--rule);
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
	}
	.sb-brand {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-3) var(--s-3) var(--s-2);
	}
	.sb-mark {
		width: 24px;
		height: 24px;
		border-radius: var(--r-sm);
		background: var(--petal);
		position: relative;
		flex: none;
	}
	.sb-mark::after {
		content: "";
		position: absolute;
		top: 0;
		right: 0;
		border-style: solid;
		border-width: 0 8px 8px 0;
		border-color: transparent var(--s1) transparent transparent;
	}
	.sb-name {
		font:
			400 0.9375rem var(--sign);
		line-height: 1.2;
	}
	.sb-name small {
		display: block;
		font:
			500 0.6875rem var(--mono);
		letter-spacing: 0.06em;
		color: var(--text-3);
		text-transform: uppercase;
	}
	nav {
		padding: var(--s-2);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.nav-item {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		height: 32px;
		padding: 0 var(--s-2);
		border-radius: var(--r-xs);
		font:
			500 0.8125rem var(--sans);
		color: var(--text-2);
		text-decoration: none;
		transition: background var(--t);
	}
	.nav-item :global(svg) {
		color: var(--text-3);
		flex: none;
	}
	.nav-item:hover {
		background: var(--s2);
	}
	.nav-item.active {
		background: var(--petal-soft);
		color: var(--petal-text);
	}
	.nav-item.active :global(svg) {
		color: var(--petal-text);
	}
	.nav-label {
		flex: 1;
	}
	.nav-badge {
		font:
			500 0.6875rem var(--mono);
		font-feature-settings: "tnum" 1;
		color: var(--text-3);
	}
	.sb-foot {
		margin-top: auto;
		padding: var(--s-2) var(--s-3) var(--s-3);
		border-top: 1px solid var(--rule);
	}
	.sb-user {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.sb-ava {
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--s2);
		color: var(--text-2);
		display: grid;
		place-items: center;
		font:
			500 0.6875rem var(--sans);
		flex: none;
	}
	.who b {
		font-weight: 500;
		font-size: 0.8125rem;
	}
	.handle {
		font:
			400 0.6875rem var(--mono);
		color: var(--text-3);
		display: block;
	}
	.sb-session {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		margin-top: var(--s-2);
		font-size: 0.6875rem;
		color: var(--text-3);
	}
	.sb-session :global(svg) {
		color: var(--jade);
	}
	.sb-state {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		margin-top: var(--s-1);
		font-size: 0.6875rem;
		color: var(--jade-text);
	}
	.sb-state :global(svg) {
		color: var(--jade);
	}
	.sb-state.cracked {
		color: var(--danger-text);
	}
	.sb-state.cracked :global(svg) {
		color: var(--danger-dot);
	}
	.sb-state.cant_verify {
		color: var(--warn-text);
	}
	.sb-state.cant_verify :global(svg) {
		color: var(--warn-dot);
	}

	/* icon rail (foundations §2.1): collapse to 56px below 1280px, keep badges. */
	@media (max-width: 1279px) {
		.sb-brand {
			justify-content: center;
			padding: var(--s-3) 0 var(--s-2);
		}
		.sb-name,
		.nav-label,
		.nav-badge,
		.who,
		.sb-session,
		.sb-state span {
			display: none;
		}
		.nav-item {
			justify-content: center;
			padding: 0;
		}
		nav {
			align-items: center;
		}
		.sb-foot {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: var(--s-2);
		}
		.sb-state {
			justify-content: center;
		}
	}
</style>
