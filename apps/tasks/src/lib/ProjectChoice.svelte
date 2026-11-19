<script>
	import { refreshAll } from "$app/navigation";

	import { chooseProject } from "#lib/gallery.remote.ts";
	import Icon from "#lib/Icon.svelte";

	/** @type {{ project: string; choice?: "follow" | "hide" }} */
	let { project, choice } = $props();

	let saving = $state(false);
	let failed = $state(false);

	// Pressing the active choice clears it, so the project goes back to following your involvement.
	async function choose(/** @type {"follow" | "hide"} */ next) {
		saving = true;
		failed = false;

		try {
			await chooseProject({ project, choice: choice === next ? null : next });
			await refreshAll();
		} catch {
			failed = true;
		} finally {
			saving = false;
		}
	}
</script>

<div class="choice" role="group" aria-label="Your view of this project">
	<button
		type="button"
		aria-pressed={choice === "follow"}
		disabled={saving}
		onclick={() => choose("follow")}
		title="Keep this project in your projects"
	>
		<Icon name={choice === "follow" ? "check" : "plus"} size={14} />
		{choice === "follow" ? "Following" : "Follow"}
	</button>
	<button
		type="button"
		aria-pressed={choice === "hide"}
		disabled={saving}
		onclick={() => choose("hide")}
		title="Leave this project out of your projects"
	>
		<Icon name="hide" size={14} />
		{choice === "hide" ? "Hidden" : "Hide"}
	</button>
	{#if failed}<span class="failed" role="alert">Not saved. Try again.</span>{/if}
</div>

<style>
	.choice {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		block-size: 40px;
		padding-inline: 12px;
		font: inherit;
		font-size: 13px;
		color: var(--text-2);
		background: var(--surface-2);
		border: 0;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition:
			background 0.12s,
			color 0.12s;
	}
	button:hover {
		background: var(--surface-3);
	}
	button[aria-pressed="true"] {
		color: var(--accent-b);
		background: var(--accent-bg);
	}
	button:disabled {
		cursor: default;
	}
	.failed {
		font-size: 13px;
		color: var(--text-1);
	}
</style>
