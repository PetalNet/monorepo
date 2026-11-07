<script lang="ts">
	import Segmented from "$lib/ui/Segmented.svelte";

	import AddPanel from "./AddPanel.svelte";
	import type { PanelTab } from "./editor.svelte";
	import EditPane from "./EditPane.svelte";
	import Layers from "./Layers.svelte";
	import TemplateList from "./TemplateList.svelte";

	/**
	 * The editor's tabbed panel. Wide screens show the inspector in its own column, so this panel
	 * offers templates instead; narrow screens fold the inspector in as "Edit".
	 */
	let { wide, tab, onchange }: { wide: boolean; tab: PanelTab; onchange: (tab: PanelTab) => void } =
		$props();

	const tabs = $derived(
		wide
			? ([
					{ value: "add", label: "Add" },
					{ value: "layers", label: "Layers" },
					{ value: "templates", label: "Templates" },
				] as const)
			: ([
					{ value: "add", label: "Add" },
					{ value: "edit", label: "Edit" },
					{ value: "layers", label: "Layers" },
				] as const),
	);
</script>

<div class="tabs">
	<Segmented label="Panel" options={tabs} value={tab} {onchange} />
</div>
<div class="body">
	{#if tab === "add"}
		<AddPanel
			onadded={() => {
				if (!wide) {
					onchange("edit");
				}
			}}
		/>
	{:else if tab === "layers"}
		<Layers />
	{:else if tab === "templates"}
		<TemplateList />
	{:else}
		<EditPane />
	{/if}
</div>

<style>
	.tabs {
		position: sticky;
		top: 0;
		z-index: 1;
		padding-block: 0 12px;
		background: var(--panel);
	}

	:global(.dock) > .tabs {
		padding: 12px 16px;
	}

	:global(.dock) > .body {
		padding: 0 16px 24px;
	}
</style>
