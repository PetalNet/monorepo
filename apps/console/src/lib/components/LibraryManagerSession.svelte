<script lang="ts">
	import AgentPresence from "./AgentPresence.svelte";
	import Icon from "./Icon.svelte";
	import type { LibraryChatMessage } from "./types";

	interface Props {
		messages: LibraryChatMessage[];
		busy?: boolean;
		connected?: boolean;
		isMock?: boolean;
		sessionId?: string | null;
		onask?: (message: string) => void;
	}

	let {
		messages,
		busy = false,
		connected = true,
		isMock = false,
		sessionId = null,
		onask,
	}: Props = $props();
	let value = $state("");
	let input = $state<HTMLInputElement | null>(null);

	export function focus() {
		input?.focus();
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		const message = value.trim();
		if (!message || busy || !connected) return;
		onask?.(message);
		value = "";
	}
</script>

<section class:active={messages.length > 0} class="manager-session" aria-label="Library manager session">
	<header>
		<AgentPresence handle="librarian" label="manager agent" />
		<span class="runtime">{isMock ? "manager fixture" : "Claude Code manager"} · per-user</span>
		<span class:ready={connected} class="state-dot" aria-hidden="true"></span>
		<span class="state">{connected ? (sessionId ? "session live" : "ready on first ask") : "unreachable"}</span>
	</header>

	{#if messages.length > 0}
		<div class="transcript" aria-live="polite">
			{#each messages as message (message.id)}
				<div class:assistant={message.role === "assistant"} class:error={message.role === "error"} class="turn">
					<span>{message.role === "user" ? "You" : message.role === "assistant" ? "Librarian" : "Session"}</span>
					<p>{message.content}</p>
				</div>
			{/each}
			{#if busy}
				<div class="working"><span></span>Consulting your readable stacks.</div>
			{/if}
		</div>
	{/if}

	<form onsubmit={submit}>
		<Icon name="sparkles" size={18} />
		<input
			bind:this={input}
			bind:value
			data-global-ask
			aria-label="Ask the librarian"
			placeholder={connected
				? "Ask the librarian. They know the way, and they know you."
				: "Librarian unreachable. The stacks still work."}
			disabled={!connected || busy}
		/>
		<button type="submit" aria-label="Send to librarian" disabled={!value.trim() || busy || !connected}>
			<Icon name="send" size={16} />
		</button>
	</form>
	<div class="hint"><kbd>/</kbd> ask · <kbd>f</kbd> literal search · ask the manager to change views or curate the reading room</div>
</section>

<style>
	.manager-session{width:640px;max-width:100%;margin:var(--s-4) auto var(--s-3);background:var(--s1);border-radius:var(--r-md);overflow:hidden;transition:width 160ms var(--ease-standard)}
	.manager-session.active{width:720px}
	header{min-height:40px;display:flex;align-items:center;gap:var(--s-2);padding:0 var(--s-3);border-bottom:1px solid var(--rule)}
	.runtime,.state{font:400 .6875rem var(--mono);color:var(--text-3)}
	.runtime{margin-inline-start:auto}.state-dot{width:7px;height:7px;border-radius:50%;background:var(--warn-dot)}.state-dot.ready{background:var(--jade)}
	.transcript{max-height:280px;overflow:auto;padding:var(--s-2) var(--s-3);scrollbar-gutter:stable}
	.turn{display:grid;grid-template-columns:64px minmax(0,1fr);gap:var(--s-2);padding:var(--s-2) 0;border-bottom:1px solid var(--rule)}
	.turn:last-child{border-bottom:0}.turn>span{font:500 .6875rem var(--mono);color:var(--text-3)}.turn.assistant>span{color:var(--jade-text)}.turn.error>span,.turn.error p{color:var(--danger-text)}
	.turn p{max-width:68ch;color:var(--text-2);font-size:.8125rem;line-height:1.55;white-space:pre-wrap;text-wrap:pretty}
	.working{display:flex;align-items:center;gap:var(--s-2);min-height:32px;color:var(--text-3);font-size:.75rem}.working span{width:8px;height:8px;border-radius:50%;background:var(--jade);animation:pulse 1.2s var(--ease-standard) infinite}
	form{min-height:56px;display:flex;align-items:center;gap:var(--s-2);background:var(--s2);padding:var(--s-2) var(--s-3)}form>:global(svg){color:var(--jade);flex:none}input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--text);font-size:.875rem}input::placeholder{color:var(--text-3)}form:focus-within{box-shadow:inset 0 0 0 2px var(--petal)}
	form button{width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:var(--r-sm);background:var(--petal-fill);color:var(--on-petal);transition:filter 140ms var(--ease-standard),transform 140ms var(--ease-standard)}form button:hover:not(:disabled){filter:brightness(.92)}form button:active:not(:disabled){transform:translateY(1px)}form button:disabled{background:var(--s3);color:var(--text-3)}form button:focus-visible{outline:2px solid var(--petal);outline-offset:2px}
	.hint{text-align:center;padding:var(--s-1) var(--s-3) var(--s-2);font-size:.6875rem;color:var(--text-3)}kbd{font:500 .6875rem var(--mono);background:var(--s2);border-radius:var(--r-xs);padding:0 var(--s-1)}
	@keyframes pulse{50%{opacity:.3}}
	@media(prefers-reduced-motion:reduce){.manager-session,form button{transition:none}.working span{animation:none}}
	@media(max-width:767px){.manager-session{margin-top:var(--s-3)}header{flex-wrap:wrap;padding-block:var(--s-1)}.runtime{margin-inline-start:0}.turn{grid-template-columns:1fr;gap:var(--s-1)}.hint{display:none}}
</style>
