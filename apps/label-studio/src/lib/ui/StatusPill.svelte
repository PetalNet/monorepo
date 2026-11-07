<script lang="ts">
	import { printerStatus } from "./printer.svelte";
	import { tapeMmActual } from "./tape";
	import { plainError } from "./words";

	let { onclick }: { onclick: () => void } = $props();

	type Tone = "ready" | "busy" | "warn" | "off" | "pending";

	const view = $derived.by((): { tone: Tone; text: string } => {
		const connection = printerStatus.connection;

		switch (connection.kind) {
			case "connecting":
				return { tone: "pending", text: "Checking printer" };
			case "unreachable":
				return { tone: "warn", text: "Server offline" };
			case "connected": {
				const { printer, queue } = connection;

				if (printer.state === "offline") {
					return { tone: "off", text: "Printer offline" };
				}

				if (printer.state === "error") {
					return { tone: "warn", text: plainError(printer.message).split(".")[0] };
				}

				if (queue.current) {
					return { tone: "busy", text: "Printing" };
				}

				return { tone: "ready", text: `${String(tapeMmActual(printer.tape.widthMm))} mm ready` };
			}
		}
	});
</script>

<button
	class="pill {view.tone}"
	type="button"
	{onclick}
	aria-label="Printer: {view.text}. Open printer details"
>
	<span class="dot" aria-hidden="true"></span>
	<span class="text num">{view.text}</span>
</button>

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 28px;
		max-width: 220px;
		padding-inline: 10px 12px;
		border: 0;
		border-radius: 999px;
		background: var(--sunken);
		color: var(--ink-2);
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition:
			background-color var(--base) var(--ease-standard),
			color var(--base) var(--ease-standard);
	}

	.pill:hover {
		background: color-mix(in oklch, var(--sunken), var(--ink) 6%);
	}

	.text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--ink-3);
		transition: background-color var(--base);
	}

	.ready {
		color: var(--ink);
	}

	.ready .dot {
		background: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}

	.busy .dot {
		background: var(--accent);
		animation: pulse 1.1s var(--ease-standard) infinite;
	}

	.warn {
		background: var(--warn-soft);
		color: var(--warn);
	}

	.warn .dot {
		background: currentColor;
	}

	.pending .dot {
		animation: pulse 1.1s var(--ease-standard) infinite;
	}

	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}

	@media (pointer: coarse) {
		.pill {
			height: 36px;
		}
	}
</style>
