<script lang="ts">
	import { resolve } from "$app/paths";
	import { day, plural } from "$lib/format";
	import type { StripDoor } from "$lib/server/door";
	import Lock from "@lucide/svelte/icons/lock";

	let { strip, selected }: { strip: readonly StripDoor[]; selected: string } = $props();

	/** One tick per KEV addition, up to this many; the rest are written as a number. */
	const TICKS = 8;

	const face = (door: StripDoor) => (door.id === "pre" ? "Pre" : door.id);
	const dates = (door: StripDoor) =>
		door.from === door.to ? day(door.from) : `${day(door.from)} to ${day(door.to, "short")}`;
</script>

<nav aria-label="Season doors">
	<ol>
		{#each strip as door (door.id)}
			<li>
				{#if door.state === "locked"}
					<span class="door locked">
						<span class="face">{face(door)}</span>
						<Lock size={12} strokeWidth={1.75} aria-hidden="true" />
						<span class="sr-only">{door.label}, locked until {day(door.from)}</span>
					</span>
				{:else}
					{@const added = door.added ?? 0}
					<a
						class="door"
						class:today={door.state === "today"}
						href="{resolve('/')}?door={door.id}"
						aria-current={door.id === selected ? "true" : undefined}
						data-sveltekit-noscroll
					>
						<span class="face">{face(door)}</span>
						<span class="tally" aria-hidden="true">
							{#each { length: Math.min(added, TICKS) }, tick (tick)}
								<i></i>
							{/each}
							{#if added > TICKS}<b>+{added - TICKS}</b>{/if}
						</span>
						<span class="sr-only">
							{door.label}, {dates(door)}{door.state === "today" ? ", today" : ""}:
							{door.added === undefined ? "no reading" : plural(added, "addition", "additions")}
						</span>
					</a>
				{/if}
			</li>
		{/each}
	</ol>
	<p class="legend">
		<span><i class="tick"></i> one vulnerability CISA added to its exploited list</span>
		<span
			><Lock size={12} strokeWidth={1.75} aria-hidden="true" /> opens on its day, US Eastern</span
		>
	</p>
</nav>

<style>
	ol {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 1px;
		margin: 0;
		padding: 0;
		list-style: none;
		background: var(--color-rule);
		perspective: 40rem;
	}
	@media (min-width: 60rem) {
		ol {
			grid-template-columns: repeat(25, minmax(0, 1fr));
		}
	}
	.door {
		position: relative;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		block-size: 5.5rem;
		padding: 0.625rem 0.5rem;
		background: var(--color-base-100);
		color: var(--color-base-content);
		text-decoration: none;
		transition:
			background-color 200ms var(--ease-out-expo),
			color 200ms var(--ease-out-expo);
	}
	.face {
		font-size: 1.125rem;
		font-weight: 300;
		line-height: 1;
	}
	.locked {
		background: var(--color-base-200);
		color: var(--color-muted);
	}
	/* A shut door: one recessed panel, with the lock where the handle would be. */
	.locked::before {
		content: "";
		position: absolute;
		inset: 4px;
		outline: 1px solid var(--color-rule);
		pointer-events: none;
	}
	.locked :global(svg) {
		align-self: flex-end;
	}
	a.door:hover {
		background: var(--color-base-300);
	}
	/* Today's door carries the one accent, as a bar along its top edge. */
	.today::before {
		content: "";
		position: absolute;
		inset: 0 0 auto;
		block-size: 3px;
		background: var(--color-primary);
	}
	a.door[aria-current] {
		background: var(--color-neutral);
		color: var(--color-neutral-content);
	}
	a.door:focus-visible {
		z-index: 2;
	}
	/* The chosen door swings open on its hinge, once, when it becomes the chosen door. */
	a.door[aria-current]::after {
		content: "";
		position: absolute;
		inset: 0;
		z-index: 1;
		background: var(--color-base-100);
		transform-origin: left center;
		transform: rotateY(-90deg);
		animation: swing 700ms var(--ease-out-expo);
		pointer-events: none;
	}
	@keyframes swing {
		from {
			transform: rotateY(0deg);
		}
		to {
			transform: rotateY(-90deg);
		}
	}
	.tally {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		block-size: 0.75rem;
	}
	.tally i,
	.tick {
		display: inline-block;
		inline-size: 2px;
		block-size: 0.75rem;
		background: currentcolor;
	}
	.tally b {
		margin-inline-start: 2px;
		font:
			400 0.6875rem/1 var(--font-mono),
			monospace;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.5rem;
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
</style>
