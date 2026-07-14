<script lang="ts">
	import { page } from "$app/state";
	import Icon from "$lib/components/Icon.svelte";
	import IconButton from "$lib/components/IconButton.svelte";
	import ModalSurface from "$lib/components/ModalSurface.svelte";
	import OpButton from "$lib/components/OpButton.svelte";
	import SegmentedControl from "$lib/components/SegmentedControl.svelte";
	import { runQuery } from "$lib/api/client";
	import { opDef } from "$lib/api/ops";
	import { isStale, lagSeconds } from "$lib/data/observability";
	import type { QueryResult } from "$lib/api/types";
	import InvestigationGraph, { type InvestigationSeed } from "./InvestigationGraph.svelte";
	import { getInvestigationGraph } from "./investigations.remote";

	let { data } = $props();
	const a = $derived(data.accounting);
	let view = $state<"dashboards" | "investigation" | "catalog">("dashboards");
	let filter = $state("");
	let activeStat = $state<string | null>(null);
	let peek = $state<{ title: string; result: QueryResult } | null>(null);
	let nowMs = $state(Date.now());
	let autoViz = $state<{ type: string; result: QueryResult | null; loading: boolean; error: boolean } | null>(null);
	let peekDialog = $state<HTMLDialogElement | null>(null);
	let handledStat = $state<string | null>(null);
	let investigationSeed = $state<InvestigationSeed | null>(null);
	let investigationInitialId = $state<string | null>(null);
	const investigationQuery = getInvestigationGraph();
	const recentInvestigations = $derived(
		(investigationQuery.current ?? [])
			.filter(({ parentId }) => parentId === null)
			.toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
			.slice(0, 3),
	);
	const filteredCatalog = $derived(a.catalog.filter((entry) => entry.type.toLowerCase().includes(filter.toLowerCase())));
	const behind = $derived(Object.values(a.queries).some((q) => isStale(q, nowMs)));
	const freshnessLag = $derived(lagSeconds(a.queries.freshness, nowMs));
	const loadOp = opDef("dashboard.load")!;
	const snoozeOp = opDef("signal.snooze")!;

	$effect(() => {
		const id = setInterval(() => nowMs = Date.now(), 1000);
		return () => clearInterval(id);
	});

	function age(iso?: string | null) {
		if (!iso) return "never";
		const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
		if (seconds < 5) return "now";
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
		if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
		return `${Math.round(seconds / 86400)}d`;
	}
	function value(result: QueryResult | null, row = 0, col = 0) { return result?.rows[row]?.[col] ?? "—"; }
	function source(result: QueryResult | null) { return result ? `${result.freshness.source} · ${result.row_count} ${result.row_count === 1 ? "row" : "rows"} · ${age(result.freshness.observed_at)}` : "query unavailable · 0 rows · not current"; }
	async function catalogOpen(type: string) {
		activeStat = type;
		autoViz = { type, result: null, loading: true, error: false };
		if (a.isMock) {
			autoViz = { type, result: a.queries.queries, loading: false, error: false };
			return;
		}
		const entry = a.catalog.find((item) => item.type === type);
		const measure = entry && Object.keys(entry.measures)[0];
		if (!measure) { autoViz = { type, result: null, loading: false, error: true }; return; }
		try {
			const result = await runQuery({ schema_version: 1, mode: "structured", from: type, select: [{ field: measure, agg: "last", as: "value" }], limit: 1 });
			autoViz = { type, result, loading: false, error: false };
		} catch { autoViz = { type, result: null, loading: false, error: true }; }
	}
	function chartSegments(result: QueryResult | null): string[] {
		if (!result?.rows.length) return [];
		const values = result.rows.map((row) => typeof row[row.length - 1] === "number" ? row[row.length - 1] as number : null);
		const numeric = values.filter((v): v is number => v !== null);
		if (!numeric.length) return [];
		const min = Math.min(...numeric), max = Math.max(...numeric), range = Math.max(1, max - min);
		const segments: string[] = [];
		let current: string[] = [];
		values.forEach((v, i) => {
			if (v === null) { if (current.length) segments.push(current.join(" ")); current = []; return; }
			current.push(`${8 + i * 462 / Math.max(1, values.length - 1)},${88 - (v - min) / range * 76}`);
		});
		if (current.length) segments.push(current.join(" "));
		return segments;
	}
	function keys(e: KeyboardEvent) {
		if (e.key === "v" && !(e.target instanceof HTMLInputElement)) {
			const views = ["dashboards", "investigation", "catalog"] as const;
			view = views[(views.indexOf(view) + 1) % views.length];
		}
		if (e.key === "f" && !(e.target instanceof HTMLInputElement)) document.querySelector<HTMLInputElement>("#catalog-filter")?.focus();
	}
	function investigateEmitter(row: unknown[]) {
		if (!a.queries.emitters?.query_ref) return;
		investigationInitialId = null;
		const scope = String(row[0] ?? "selected scope");
		investigationSeed = {
			title: `Why did ${scope} event volume stand out?`,
			queryRef: a.queries.emitters.query_ref,
			panelTitle: "Top emitters, 24h",
			panelType: "bar",
			selectedField: "scope",
			selectedValue: scope,
		};
		view = "investigation";
	}
	function openInvestigation(id: string) {
		investigationInitialId = id;
		investigationSeed = null;
		view = "investigation";
	}
	$effect(() => {
		const statistic = page.url.searchParams.get("stat");
		if (!statistic || statistic === handledStat) return;
		handledStat = statistic;
		view = "catalog";
		filter = statistic;
		if (a.catalog.some((entry) => entry.type === statistic)) void catalogOpen(statistic);
	});
</script>

<svelte:window onkeydown={keys} />

<div class="sign">
	<div class="identity"><h1>Observability</h1><span title="The Point System. Every action has a value.">Accounting</span><small class:behind>{a.isMock ? "Fixture scene · not live." : behind ? `Accounting is behind. Numbers older than ${new Date(Math.min(...Object.values(a.queries).filter(Boolean).map((q) => Date.parse(q!.freshness.observed_at)))).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} only.` : a.errors.length ? "Accounting can't verify every panel." : "Accounting is current."}</small></div>
	<SegmentedControl
		class="view-segments"
		label="Observability view"
		value={view}
		options={[
			{ value: "dashboards", label: "Dashboards" },
			{ value: "investigation", label: "Investigation" },
			{ value: "catalog", label: "Catalog" },
		]}
		onchange={(next) => view = next}
	/>
</div>

{#if a.errors.length}
	<div class="notice" role="status"><Icon name="circle-help" size={15} /><span>{a.errors.join(" · ")}. Missing reads are shown as unavailable, never as fixture data.</span></div>
{/if}

{#if behind}
	<section class="crack" aria-label="Accounting ingest degraded"><div><Icon name="triangle-alert" size={16}/><b>Accounting is behind.</b><span>Affected panels are watermarked and actions on stale results are blocked.</span></div><div><OpButton def={loadOp} args={{ id: "curated-ingest" }} lanes={a.lanes} executorLive={a.executors.library} label="Watch ingest"/><OpButton def={snoozeOp} args={{ type_pattern: "lake.ingest.*", duration_s: 3600 }} lanes={a.lanes} executorLive={a.executors.consoleApi}/></div></section>
{/if}

{#if view === "dashboards"}
	<div class="obs-grid">
		<main class="obs-main">
			<div class="vitals">
				<article class="panel chart-panel" class:stale={isStale(a.queries.events, nowMs)}>
					<header><div><h2>Bus events per minute</h2><p>All scopes you can see</p></div>{#if isStale(a.queries.events, nowMs)}<span class="stalled">STALLED</span>{:else if a.queries.events && !a.isMock}<span class="queried">QUERY</span>{/if}</header>
					{#if a.queries.events}
						<svg class="chart" viewBox="0 0 520 96" preserveAspectRatio="none" role="img" aria-label="Bus events per minute line chart">
							<line x1="0" y1="88" x2="520" y2="88"/><line x1="0" y1="48" x2="520" y2="48"/><line x1="0" y1="8" x2="520" y2="8"/>
							{#each chartSegments(a.queries.events) as points}<polyline {points}/>{/each}
						</svg>
					{:else}<div class="query-empty">Query failed. Nothing rendered, nothing pretended.</div>{/if}
					<footer><Icon name="receipt-text" size={12}/><span>{source(a.queries.events)}</span>{#if a.queries.events}<button onclick={() => peek = { title: "Bus events per minute", result: a.queries.events! }}>Show the math.</button>{/if}</footer>
				</article>
				<article class="panel freshness" class:stale={isStale(a.queries.freshness, nowMs)}>
					<header><div><h2>Lake freshness</h2><p>Ingest lag, newest statistic</p></div></header>
					<div class="stat"><b>{freshnessLag ?? "—"}{freshnessLag === null ? "" : "s"}</b><span>behind newest event</span></div>{#if freshnessLag !== null && a.queries.freshness?.freshness.window_s != null}<div class:proof={!isStale(a.queries.freshness, nowMs)} class:late={isStale(a.queries.freshness, nowMs)}>{isStale(a.queries.freshness, nowMs) ? "outside its contracted window" : "inside its contracted window"}</div>{/if}
					<footer><Icon name="receipt-text" size={12}/><span>{source(a.queries.freshness)}</span>{#if a.queries.freshness}<button onclick={() => peek = { title: "Lake freshness", result: a.queries.freshness! }}>Show the math.</button>{/if}</footer>
				</article>
				<article class="panel queries" class:stale={isStale(a.queries.queries, nowMs)}>
					<header><div><h2>Queries today</h2><p>Everyone in scope</p></div></header>
					<div class="stat"><b>{value(a.queries.queries)}</b><span>runs</span></div>
					<footer><Icon name="receipt-text" size={12}/><span>{source(a.queries.queries)}</span>{#if a.queries.queries}<button onclick={() => peek = { title: "Queries today", result: a.queries.queries! }}>Show the math.</button>{/if}</footer>
				</article>
				<article class="panel emitters" class:stale={isStale(a.queries.emitters, nowMs)}>
					<header><div><h2>Top emitters, 24h</h2><p>Grouped by visible scope</p></div></header>
					{#if a.queries.emitters?.rows.length}<table><thead><tr>{#each a.queries.emitters.columns as c}<th>{c.name}</th>{/each}<th><span class="sr-only">Action</span></th></tr></thead><tbody>{#each a.queries.emitters.rows.slice(0, 4) as row}<tr>{#each row as cell}<td>{typeof cell === "number" ? cell.toLocaleString() : String(cell)}</td>{/each}<td><button class="investigate" onclick={() => investigateEmitter(row)} disabled={!a.queries.emitters?.query_ref}><Icon name="git-branch" size={12}/>Investigate</button></td></tr>{/each}</tbody></table>{:else}<div class="query-empty">No emitter rows in your scope.</div>{/if}
					<footer><Icon name="receipt-text" size={12}/><span>{source(a.queries.emitters)}</span>{#if a.queries.emitters}<button onclick={() => peek = { title: "Top emitters", result: a.queries.emitters! }}>Show the math.</button>{/if}</footer>
				</article>
			</div>
			{#if autoViz}<article class="panel auto-viz"><header><div><h2>{autoViz.type}</h2><p>Deterministic catalog profile · no assistant</p></div></header>{#if autoViz.loading}<div class="skeleton" aria-label="Profiling statistic"></div>{:else if autoViz.error}<div class="query-empty">Profile query failed. Nothing rendered, nothing pretended.</div>{:else if autoViz.result}<div class="stat"><b>{value(autoViz.result)}</b><span>{Object.values(a.catalog.find((entry) => entry.type === autoViz?.type)?.measures ?? {})[0]?.unit ?? "latest"}</span></div><footer><Icon name="receipt-text" size={12}/><span>{source(autoViz.result)}</span><button onclick={() => peek = { title: autoViz!.type, result: autoViz!.result! }}>Show the math.</button></footer>{/if}</article>{/if}

			<section class="saved"><div class="strip"><h2>Saved dashboards</h2><a href="/library?kind=artifact">All saved</a></div>
				{#if a.dashboards.length}<div class="tiles">{#each a.dashboards.slice(0, 3) as d}<a href="/observability?dashboard={d.id}"><b>{d.title}</b><span>{d.panel_count} panels{d.is_home ? " · home" : ""}</span></a>{/each}</div>{:else}<p class="empty">No saved dashboards. Ask a question and keep what comes back.</p>{/if}
			</section>
			<section class="investigations"><div class="strip"><h2>Recent investigations</h2><span>Bearimy view</span></div>{#if recentInvestigations.length}
				{#each recentInvestigations as investigation}<button onclick={() => openInvestigation(investigation.id)}><Icon name="git-branch" size={14}/><b>{investigation.title}</b><span>{investigation.createdBy ?? "unknown"} · {investigation.panelCount}p · {age(investigation.updatedAt)}</span></button>{/each}
			{:else if !investigationQuery.current}<p class="empty">Loading investigation history.</p>
			{:else}<p class="empty">No investigations yet.</p>{/if}
			</section>
		</main>
		<aside class="rail">
			<div class="strip"><h2>Statistics catalog</h2><span>what is instrumented</span></div>
			<label><Icon name="search" size={14}/><span class="sr-only">Filter statistics</span><input id="catalog-filter" bind:value={filter} placeholder="Filter statistics"/></label>
			{#each filteredCatalog as entry (entry.type)}<button class:active={activeStat === entry.type} onclick={() => catalogOpen(entry.type)}><i class:idle={!entry.last_emit || (entry.emit_rate_per_min ?? 0) < .05}></i><code>{entry.type}</code><span>{Object.keys(entry.measures).some((m) => entry.measures[m]?.kind === "counter") ? "event" : "metric"}</span><time>{age(entry.last_emit)}</time></button>{/each}
			{#if !filteredCatalog.length}<p class="empty">No statistics match.</p>{/if}
			<p class="rail-note">Click charts it. Rows outside your scope never arrive.</p>
		</aside>
	</div>
{:else if view === "investigation"}
	<InvestigationGraph seed={investigationSeed} initialId={investigationInitialId} onseeded={() => investigationSeed = null}/>
{:else}
	<section class="catalog-full"><div class="strip"><h2>Statistics catalog</h2><span>{filteredCatalog.length} visible types</span></div><label><Icon name="search" size={14}/><input id="catalog-filter" bind:value={filter} placeholder="Filter statistics" aria-label="Filter statistics"/></label>{#each filteredCatalog as entry}<button onclick={() => catalogOpen(entry.type)}><code>{entry.type}</code><span>{Object.keys(entry.dimensions).length} dimensions · {Object.keys(entry.measures).length} measures</span><time>{age(entry.last_emit)}</time><Icon name="chevron-right" size={14}/></button>{/each}</section>
{/if}

<ModalSurface bind:element={peekDialog} open={peek!==null} variant="dialog" labelledby="query-detail-title" onclose={() => peek = null}>{#if peek}<div class="peek"><IconButton class="dialog-close" name="x" label="Close query detail" autofocus onclick={() => peekDialog?.close()}/><h2 id="query-detail-title">{peek.title}</h2><h3>Question</h3><p>Curated Accounting query</p><h3>Query · structured reference</h3><pre>{JSON.stringify({ query_ref: peek.result.query_ref }, null, 2)}</pre><h3>Result meta</h3><p class="mono">{peek.result.row_count} rows · {peek.result.execution_ms ?? "—"}ms · {peek.result.freshness.observed_at}</p><footer><button onclick={() => navigator.clipboard.writeText(peek?.result.query_ref ?? "")}>Copy query ref</button><button onclick={() => peekDialog?.close()}>Done</button></footer></div>{/if}</ModalSurface>

<style>
	.sign{display:flex;align-items:center;min-height:40px;gap:var(--s-3)}.identity{display:flex;align-items:baseline;gap:var(--s-3);min-width:0}.identity h1{font:400 1.25rem var(--sign)}.identity>span{font:400 .875rem var(--sign);color:var(--jade-text)}.identity small{font:400 .75rem var(--mono);color:var(--text-3)}.identity small.behind{color:var(--danger-text)}:global(.view-segments){margin-inline-start:auto}
	.notice{display:flex;gap:var(--s-2);align-items:center;margin-top:var(--s-2);padding:var(--s-2) var(--s-3);background:var(--warn-soft);color:var(--warn-text);border-radius:var(--r-xs);font-size:.75rem}.crack{display:flex;justify-content:space-between;align-items:center;gap:var(--s-3);background:var(--danger-soft);border-radius:var(--r-xs);padding:var(--s-3);margin-top:var(--s-2)}.crack>div{display:flex;align-items:center;gap:var(--s-2)}.crack b{color:var(--danger-text);font-size:.875rem}.crack span{font-size:.75rem;color:var(--text-2)}.obs-grid{display:grid;grid-template-columns:minmax(0,1fr) 344px;gap:var(--s-3);padding:var(--s-3) 0 104px}.obs-main{min-width:0;display:flex;flex-direction:column;gap:var(--s-4)}.vitals{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:var(--s-3)}.panel{background:var(--s1);border-radius:var(--r-xs);padding:var(--s-3);min-height:200px;display:flex;flex-direction:column;min-width:0}.panel.stale{position:relative;background:linear-gradient(135deg,var(--s1) 0 88%,var(--s3) 88%)}.panel.stale::after{content:"stale";position:absolute;right:var(--s-2);bottom:var(--s-1);font:500 .6875rem var(--mono);color:var(--warn-text)}.chart-panel{grid-column:span 7}.freshness{grid-column:span 5}.queries{grid-column:span 4}.emitters{grid-column:span 8}.panel header{display:flex;justify-content:space-between;gap:var(--s-2)}.panel h2,.strip h2{font:500 .84375rem var(--sans)}.panel header p{font-size:.6875rem;color:var(--text-3);margin-top:var(--s-1)}.queried,.stalled{font:500 .6875rem var(--mono);color:var(--jade-text)}.stalled{color:var(--warn-text)}.chart{width:100%;height:96px;margin:auto 0}.chart line{stroke:var(--rule);stroke-width:1}.chart polyline{fill:none;stroke:var(--petal);stroke-width:2;stroke-linejoin:round}.panel footer{margin-top:auto;padding-top:var(--s-2);border-top:1px solid var(--rule);display:flex;align-items:center;gap:var(--s-2);font:400 .6875rem var(--mono);color:var(--text-3)}.panel footer button{margin-inline-start:auto;border:0;background:none;color:var(--petal-text);font-weight:500}.stat{display:flex;align-items:baseline;gap:var(--s-2);margin:auto 0}.stat b{font:500 1.75rem var(--mono);text-decoration:underline;text-decoration-color:var(--jade);text-underline-offset:5px}.stat span,.proof,.late{font-size:.75rem;color:var(--text-3)}.proof{color:var(--jade-text)}.late{color:var(--warn-text)}table{width:100%;border-collapse:collapse;margin:var(--s-2) 0;font:400 .75rem var(--mono)}th{text-align:left;color:var(--text-3);font-weight:500}td,th{padding:4px var(--s-1);border-bottom:1px solid var(--rule)}td:not(:first-child),th:not(:first-child){text-align:right}.query-empty,.empty{color:var(--text-3);font-size:.75rem;margin:auto 0}.strip{display:flex;align-items:baseline;gap:var(--s-2);min-height:24px}.strip span,.strip a{font-size:.6875rem;color:var(--text-3)}.strip a{margin-inline-start:auto;color:var(--petal-text)}.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--s-3);margin-top:var(--s-2)}.tiles a{background:var(--s1);border-radius:var(--r-xs);padding:var(--s-2) var(--s-3);text-decoration:none;color:var(--text)}.tiles a:hover{background:var(--s2)}.tiles b{display:block;font-size:.8125rem}.tiles span{font:400 .6875rem var(--mono);color:var(--text-3)}.investigations>button{width:100%;border:0;background:none;display:flex;align-items:center;gap:var(--s-2);min-height:40px;padding:0 var(--s-2);color:var(--text-2);border-radius:var(--r-xs)}.investigations>button:hover{background:var(--s2)}.investigations b{font-size:.8125rem;color:var(--text)}.investigations>button span{margin-inline-start:auto;font:400 .6875rem var(--mono);color:var(--text-3)}.investigations>.empty{padding:var(--s-2)}.auto-viz{min-height:168px}.skeleton{height:64px;margin:auto 0;background:var(--s3);border-radius:var(--r-xs)}
	.rail{background:var(--s1);border-radius:var(--r-xs);padding:var(--s-3);align-self:start}.rail label,.catalog-full label{display:flex;align-items:center;gap:var(--s-2);background:var(--s2);border-radius:var(--r-sm);min-height:32px;padding:0 var(--s-2);margin:var(--s-2) 0}.rail label:focus-within,.catalog-full label:focus-within{box-shadow:0 0 0 2px var(--petal)}.rail input,.catalog-full input{border:0;background:none;outline:none;min-width:0;width:100%;color:var(--text);font-size:.75rem}.rail>button{border:0;background:none;width:100%;min-height:32px;display:flex;align-items:center;gap:var(--s-2);padding:0 var(--s-2);border-radius:var(--r-xs);color:var(--text-2)}.rail>button:hover{background:var(--s2)}.rail>button.active{background:var(--petal-soft);color:var(--petal-text)}.rail>button>i{width:6px;height:6px;border-radius:50%;background:var(--jade);flex:none}.rail>button>i.idle{background:var(--text-3)}.rail code{font-size:.6875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rail button span{font:500 .6875rem var(--mono);text-transform:uppercase;color:var(--text-3)}.rail time{margin-inline-start:auto;font:400 .6875rem var(--mono);color:var(--text-3)}.rail-note{font-size:.6875rem;color:var(--text-3);margin:var(--s-2)}
	.peek footer button,.investigate{border:0;background:var(--s2);color:var(--text-2);border-radius:var(--r-sm);padding:var(--s-1) var(--s-2);margin-inline-start:var(--s-2);min-height:32px}.investigate{display:inline-flex;align-items:center;gap:var(--s-1);background:var(--petal-soft);color:var(--petal-text);font:500 .6875rem var(--sans)}.catalog-full{max-width:920px;padding:var(--s-3) 0 104px}.catalog-full>button{border:0;background:none;width:100%;display:grid;grid-template-columns:1fr 220px 60px 16px;gap:var(--s-3);align-items:center;text-align:left;min-height:40px;padding:0 var(--s-2);color:var(--text-2);border-radius:var(--r-xs)}.catalog-full>button:hover{background:var(--s2)}.catalog-full>button span,.catalog-full time{font:400 .6875rem var(--mono);color:var(--text-3)}
	.peek h2{font-size:.875rem}.peek h3{font:500 .6875rem var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);margin:var(--s-3) 0 var(--s-1)}.peek p{font-size:.8125rem}.peek pre{background:var(--s3);border-radius:var(--r-xs);padding:var(--s-2);font:400 .6875rem var(--mono);overflow:auto}.peek footer{border-top:1px solid var(--rule);padding-top:var(--s-2);margin-top:var(--s-3);text-align:right}.mono{font-family:var(--mono)!important;color:var(--text-3)}
	@media(max-width:900px){.obs-grid{grid-template-columns:1fr}.rail{display:none}.chart-panel,.freshness,.queries,.emitters{grid-column:span 12}}@media(max-width:767px){.sign{align-items:flex-start;flex-direction:column;height:auto}.identity small,:global(.view-segments){display:none}.crack{align-items:flex-start;flex-direction:column}.obs-grid{padding-bottom:104px}.vitals,.investigations{display:none}.tiles{grid-template-columns:1fr}.saved{margin-top:var(--s-2)}.catalog-full>button{grid-template-columns:1fr 56px 16px}.catalog-full>button span{display:none}}
</style>
