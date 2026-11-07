<script lang="ts">
	import Sheet from "$lib/ui/Sheet.svelte";

	import { SHORTCUTS } from "./shortcuts";

	let { open = $bindable(false) }: { open?: boolean } = $props();
	const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
</script>

<Sheet bind:open title="Keyboard shortcuts" width="420px">
	<dl class="keys">
		{#each SHORTCUTS as shortcut (shortcut.keys)}
			<dt>
				{#each shortcut.keys.replaceAll("Mod", mod).split(" + ") as key, index (index)}
					<kbd>{key}</kbd>
				{/each}
			</dt>
			<dd>{shortcut.does}</dd>
		{/each}
	</dl>
</Sheet>

<style>
	.keys {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 10px 16px;
		margin: 0;
	}

	dt {
		display: flex;
		gap: 4px;
	}

	dd {
		margin: 0;
		color: var(--ink-2);
	}

	kbd {
		min-width: 24px;
		padding: 2px 6px;
		border-radius: var(--r);
		background: var(--sunken);
		box-shadow: inset 0 -1px 0 var(--rule-strong);
		font-family: inherit;
		font-size: 12px;
		text-align: center;
		white-space: pre;
	}
</style>
