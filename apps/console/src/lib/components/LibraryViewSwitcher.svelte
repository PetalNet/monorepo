<script lang="ts">
	import Icon from "./Icon.svelte";

	export type LibraryView = "list" | "graph" | "kanban" | "table";
	interface Props {
		value: LibraryView;
		disabled?: boolean;
		onchange: (view: LibraryView) => void;
	}
	let { value, disabled = false, onchange }: Props = $props();
	const views = [
		{ id: "list", label: "List", icon: "library" },
		{ id: "graph", label: "Graph", icon: "git-branch" },
		{ id: "kanban", label: "Kanban", icon: "kanban" },
		{ id: "table", label: "Table", icon: "columns-2" },
	] as const;
</script>

<div class="view-switcher" role="group" aria-label="Library view">
	{#each views as view}
		<button
			type="button"
			aria-pressed={value === view.id}
			class:active={value === view.id}
			{disabled}
			onclick={() => onchange(view.id)}
		>
			<Icon name={view.icon} size={14} />
			<span>{view.label}</span>
		</button>
	{/each}
</div>

<style>
	.view-switcher { display:flex; align-items:center; gap:var(--s-1); padding:var(--s-1); background:var(--s2); border-radius:var(--r-sm); }
	button { min-height:32px; padding:0 var(--s-2); border:0; border-radius:var(--r-sm); background:transparent; color:var(--text-2); display:flex; align-items:center; gap:var(--s-1); font:500 .75rem var(--sans); transition:background 120ms var(--ease-standard), color 120ms var(--ease-standard); }
	button:hover:not(:disabled) { background:var(--s3); color:var(--text); }
	button.active { background:var(--petal-soft); color:var(--petal-text); }
	button:focus-visible { outline:2px solid var(--petal); outline-offset:2px; }
	button:disabled { opacity:.45; }
	@media (max-width: 900px) { button span { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); } button { width:32px; justify-content:center; padding:0; } }
	@media (prefers-reduced-motion: reduce) { button { transition:none; } }
</style>
