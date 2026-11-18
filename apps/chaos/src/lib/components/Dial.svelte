<script lang="ts">
	/**
	 * A half-circle gauge. It is a picture of a reading the caller also prints in words, so it is
	 * hidden from screen readers. The needle is drawn only for a real reading: with `fraction`
	 * undefined the dial stays empty, so a missing number never looks like a zero.
	 */
	let {
		fraction,
		steps,
		majors,
		hotFrom,
	}: {
		/** Where the needle sits, from 0 (left) to 1 (right). */
		fraction: number | undefined;
		/** Scale divisions, one minor tick each. */
		steps: number;
		/** The steps that carry a numbered major tick. */
		majors: readonly number[];
		/** The scale from this fraction up is marked as the heavy end. */
		hotFrom: number;
	} = $props();

	const R = 84;
	const point = (at: number, radius: number) => {
		const angle = Math.PI * (1 - at);

		return [radius * Math.cos(angle), -radius * Math.sin(angle)] as const;
	};
	const arc = (from: number, to: number, radius: number) => {
		const [x1, y1] = point(from, radius);
		const [x2, y2] = point(to, radius);

		return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${String(radius)} ${String(radius)} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
	};
	const ticks = $derived(
		Array.from({ length: steps + 1 }, (_, step) => {
			const major = majors.includes(step);
			const [x1, y1] = point(step / steps, R);
			const [x2, y2] = point(step / steps, major ? R - 12 : R - 6);
			const [tx, ty] = point(step / steps, R - 24);

			return { step, major, x1, y1, x2, y2, tx, ty };
		}),
	);
</script>

<svg viewBox="-100 -96 200 108" aria-hidden="true">
	<path class="scale" d={arc(0, 1, R)} />
	<path class="hot" d={arc(hotFrom, 1, R + 5)} />
	{#each ticks as tick (tick.step)}
		<line
			class="tick"
			class:major={tick.major}
			x1={tick.x1}
			y1={tick.y1}
			x2={tick.x2}
			y2={tick.y2}
		/>
		{#if tick.major}
			<text x={tick.tx} y={tick.ty} text-anchor="middle" dominant-baseline="middle"
				>{tick.step}</text
			>
		{/if}
	{/each}
	{#if fraction !== undefined}
		<line
			class="needle"
			x1="12"
			y1="0"
			x2={-(R - 32)}
			y2="0"
			style:--turn="{Math.min(1, Math.max(0, fraction)) * 180}deg"
		/>
	{/if}
	<circle class="hub" class:empty={fraction === undefined} r="5" />
</svg>

<style>
	svg {
		display: block;
		inline-size: 100%;
		overflow: visible;
	}
	path {
		fill: none;
	}
	.scale {
		stroke: var(--color-rule-strong);
		stroke-width: 1;
	}
	.hot {
		stroke: var(--color-primary);
		stroke-width: 3;
	}
	.tick {
		stroke: var(--color-rule-strong);
		stroke-width: 1;
	}
	.major {
		stroke: var(--color-base-content);
	}
	text {
		fill: var(--color-muted);
		font:
			400 8px var(--font-mono),
			monospace;
	}
	/* The needle swings up from zero to its reading, once, like a gauge taking power. */
	.needle {
		stroke: var(--color-primary);
		stroke-width: 2.5;
		stroke-linecap: round;
		transform-origin: 0 0;
		transform: rotate(var(--turn));
		transition: transform 1600ms var(--ease-out-expo);
	}
	@starting-style {
		.needle {
			transform: rotate(0deg);
		}
	}
	.hub {
		fill: var(--color-base-content);
	}
	.hub.empty {
		fill: var(--color-base-100);
		stroke: var(--color-rule-strong);
	}
</style>
