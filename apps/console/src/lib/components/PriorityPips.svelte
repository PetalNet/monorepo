<script lang="ts">
	let { priority }: { priority: 0 | 1 | 2 | 3 } = $props();
	const filled = $derived(3 - priority);
</script>
<span class="priority p{priority}" aria-label={`Priority P${String(priority)}`}><span class="pips" aria-hidden="true">{#each [0, 1, 2] as pip, __eachKey17 (__eachKey17)}<i class:filled={pip < filled}></i>{/each}</span><b>P{priority}</b></span>
<style>
	.priority{display:inline-flex;align-items:center;gap:var(--s-1);font:500 .6875rem var(--mono);color:var(--text-3)}.pips{display:inline-flex;align-items:flex-end;gap:2px}.pips i{width:2px;height:8px;border-radius:1px;background:var(--rule-strong)}.pips i.filled{background:var(--text-3)}.p0,.p0 .pips i.filled{color:var(--danger-text);background-color:transparent}.p0 .pips i.filled{background:var(--danger-dot)}.p1,.p1 .pips i.filled{color:var(--warn-text)}.p1 .pips i.filled{background:var(--warn-dot)}
</style>
