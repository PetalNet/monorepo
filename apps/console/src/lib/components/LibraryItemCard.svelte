<script lang="ts">
	import Icon from "./Icon.svelte";
	import AgentPresence from "./AgentPresence.svelte";
	import type { LibraryItemView } from "$lib/data/library";
	interface Props { item: LibraryItemView; compact?: boolean; onopen?: (item: LibraryItemView) => void; }
	let { item, compact = false, onopen }: Props = $props();
	const icons = { task:"circle-check", project:"folder", doc:"file-text", artifact:"package", research:"microscope", fact:"quote", decision:"milestone", "how-to":"list-ordered" };
</script>
<button class="item" class:compact onclick={() => onopen?.(item)}>
	<span class="kind {item.kind}"><Icon name={icons[item.kind]} size={14}/></span>
	<span class="body"><b>{item.title}</b><small>{item.kind} · {item.project} · v{item.version} · {item.updated}</small><AgentPresence handle={item.creator} label="created by"/>{#if item.hold}<em>{item.hold}</em>{/if}</span>
</button>
<style>
	.item{width:100%;border:0;background:transparent;color:var(--text);display:flex;align-items:flex-start;gap:var(--s-2);padding:var(--s-2);border-radius:var(--r-xs);text-align:left;min-height:48px}.item:hover{background:var(--s2)}.item:focus-visible{outline:2px solid var(--petal);outline-offset:2px}.kind{width:24px;height:24px;display:grid;place-items:center;border-radius:var(--r-xs);background:var(--info-soft);color:var(--info-text);flex:none}.kind.task,.kind.project{background:var(--petal-soft);color:var(--petal-text)}.kind.artifact{background:var(--jade-soft);color:var(--jade-text)}.kind.research{background:var(--research-soft);color:var(--research-text)}.kind.decision{background:var(--warn-soft);color:var(--warn-text)}.body{min-width:0;display:block}.body b{display:block;font:500 .84375rem var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.body small{display:block;font:400 .6875rem var(--mono);color:var(--text-3);margin-top:2px}.body em{display:block;font:400 .6875rem var(--sans);color:var(--jade-text);margin-top:2px}.compact{min-height:40px;padding:var(--s-1)}.compact .kind{width:20px;height:20px}.compact em{display:none}
</style>
