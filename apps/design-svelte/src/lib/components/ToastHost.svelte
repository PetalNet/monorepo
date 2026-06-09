<script lang="ts">
	import Icon from "./Icon.svelte";
	import { toasts } from "../toasts.svelte";

	/** The bottom-left snackbar host. Renders the live toast stack. */
</script>

<div class="toast-host" id="toast-host" aria-live="polite">
	{#each toasts.items as t (t.id)}
		<div class="toast{t.show ? ' show' : ''}" role="status">
			<span class="tdot" aria-hidden="true"></span><span class="tmsg">{t.msg}</span><button
				class="tclose"
				aria-label="Dismiss"
				onclick={() => toasts.remove(t.id)}><Icon name="x" /></button>
		</div>
	{/each}
</div>
