<script lang="ts">
	import Icon from "./Icon.svelte";

	/**
	 * The ask box is the one input (foundations §5.1, /task/699). Three states:
	 *   centered (fresh cockpit, 640px pill) — the home's pinned panels surround it
	 *   docked  (after asking, 48px bottom-center bar) — drops out of the way,
	 *           never leaves; a thin transcript strip sits above
	 * While the assistant works the bar shows staged honest progress (pulse
	 * permitted). Assistant-down state says so plainly; every surface stays live.
	 * Class names avoid the DaisyUI component namespace (hero/dock/btn/progress).
	 */
	export interface ContextPayload {
		label: string;
	}
	interface Props {
		mode: "centered" | "docked";
		greeting?: string;
		/** Right-click-ask payload shown as a chip in the input (§4.3). */
		context?: ContextPayload | null;
		/** Staged progress line while the assistant composes; null = quiet. */
		progress?: string | null;
		/** Last assistant line, shown in the transcript strip above the bar. */
		transcript?: string | null;
		/** Per-user session unreachable (§5.1) — honest, surfaces stay live. */
		assistantDown?: boolean;
		onask?: (question: string) => void;
		onclearcontext?: () => void;
	}
	let {
		mode,
		greeting = "Ask Janet anything about the lab.",
		context = null,
		progress = null,
		transcript = null,
		assistantDown = false,
		onask,
		onclearcontext,
	}: Props = $props();

	let value = $state("");
	let inputEl = $state<HTMLInputElement | null>(null);

	export function focus() {
		inputEl?.focus();
	}

	function submit(e: Event) {
		e.preventDefault();
		const q = value.trim();
		if (!q || assistantDown) return;
		onask?.(q);
		value = "";
	}
</script>

{#if mode === "centered"}
	<div class="ask-centered">
		<form class="ask-box big" class:down={assistantDown} onsubmit={submit}>
			<Icon name="sparkles" size={18} />
			{#if context}
				<button type="button" class="ctx" onclick={onclearcontext} title="Clear context">
					<Icon name="mouse-pointer-2" size={11} />{context.label}
				</button>
			{/if}
			<input
				bind:this={inputEl}
				bind:value
				data-global-ask
				placeholder={assistantDown ? "Janet unreachable. Surfaces still live." : greeting}
				disabled={assistantDown}
				aria-label="Ask Janet"
			/>
		</form>
		<div class="hint">
			press <kbd>/</kbd> anywhere · right-click anything to ask about it ·
			<kbd>g</kbd> then a key jumps surfaces
		</div>
	</div>
{:else}
	<div class="ask-dockwrap">
		{#if transcript}
			<div class="transcript"><b>Janet</b> · {transcript}</div>
		{/if}
		<form class="ask-bar" class:down={assistantDown} onsubmit={submit}>
			<Icon name="sparkles" size={18} />
			{#if context}
				<button type="button" class="ctx" onclick={onclearcontext} title="Clear context">
					<Icon name="mouse-pointer-2" size={11} />{context.label}
				</button>
			{/if}
			{#if progress}
				<span class="stage"><span class="pulse-dot"></span>{progress}</span>
			{:else}
				<input
					bind:this={inputEl}
					bind:value
					data-global-ask
					placeholder={assistantDown
						? "Janet unreachable. Surfaces still live."
						: "Ask about what you clicked, or anything else."}
					disabled={assistantDown}
					aria-label="Ask Janet"
				/>
			{/if}
		</form>
	</div>
{/if}

<style>
	.ask-centered {
		margin: var(--s-3) auto;
		width: 640px;
		max-width: 100%;
		text-align: center;
	}
	.ask-box {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		background: var(--s2);
		border-radius: var(--r-pill);
		padding: var(--s-3) var(--s-4);
		text-align: start;
	}
	.ask-box :global(svg) {
		color: var(--jade);
		flex: none;
	}
	.ask-box.down :global(svg) {
		color: var(--text-3);
	}
	input {
		flex: 1;
		border: 0;
		background: transparent;
		color: var(--text);
		font:
			400 0.875rem var(--sans);
		min-width: 0;
	}
	input::placeholder {
		color: var(--text-3);
	}
	input:focus {
		outline: none;
	}
	.ask-box:focus-within {
		box-shadow: 0 0 0 2px var(--petal);
	}
	.hint {
		font-size: 0.6875rem;
		color: var(--text-3);
		margin-top: var(--s-2);
	}
	kbd {
		font:
			500 0.6875rem var(--mono);
		background: var(--s2);
		border-radius: var(--r-xs);
		padding: 0 var(--s-1);
	}
	/* docked */
	.ask-dockwrap {
		position: absolute;
		inset-inline: 0;
		bottom: var(--s-3);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--s-2);
		z-index: var(--z-dock);
		pointer-events: none;
	}
	.transcript {
		width: 720px;
		max-width: 90%;
		background: var(--s1);
		border-radius: var(--r-xs);
		padding: var(--s-2) var(--s-3);
		font-size: 0.75rem;
		color: var(--text-3);
		pointer-events: auto;
	}
	.transcript b {
		color: var(--jade-text);
		font-weight: 500;
	}
	.ask-bar {
		width: 720px;
		max-width: 90%;
		display: flex;
		align-items: center;
		gap: var(--s-2);
		background: var(--s1);
		/* Inset hairline ring: permitted ONLY for the snackbar and the dock
		 * (foundations §3.1) — this is the dock. Focus adds the outset petal ring. */
		box-shadow: inset 0 0 0 1px var(--rule-strong);
		border-radius: var(--r-pill);
		padding: 0.75rem var(--s-3);
		min-height: 48px;
		pointer-events: auto;
	}
	.ask-bar:focus-within {
		box-shadow:
			inset 0 0 0 1px var(--rule-strong),
			0 0 0 2px var(--petal);
	}
	.ask-bar :global(svg) {
		color: var(--jade);
		flex: none;
	}
	.stage {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		font-size: 0.8125rem;
		color: var(--text-3);
	}
	.pulse-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--jade);
		animation: pulse 1.2s var(--ease-standard) infinite;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.3;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse-dot {
			animation: none;
		}
	}
	.ctx {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
		background: var(--jade-soft);
		color: var(--jade-text);
		border: 0;
		cursor: pointer;
		border-radius: var(--r-xs);
		padding: 2px var(--s-1);
		font:
			500 0.6875rem var(--mono);
		flex: none;
	}
</style>
