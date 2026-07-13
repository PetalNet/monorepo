<script lang="ts">
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	import Icon from "$lib/components/Icon.svelte";
	import LibraryGraphView from "$lib/components/LibraryGraphView.svelte";
	import LibraryItemCard from "$lib/components/LibraryItemCard.svelte";
	import LibraryKanbanView from "$lib/components/LibraryKanbanView.svelte";
	import LibraryManagerSession, { type LibraryChatMessage } from "$lib/components/LibraryManagerSession.svelte";
	import LibraryViewSwitcher, { type LibraryView } from "$lib/components/LibraryViewSwitcher.svelte";
	import { libraryLinks, type LibraryItemView, type LibraryKind } from "$lib/data/library";
	import type { KnowledgeLane, WorkLane } from "$lib/data/library-views";
	import { settledTaskLibraryItem } from "$lib/data/work-settlement";
	import { getWorkSettlement } from "$lib/data/work-settlement.remote";
	import { snackbar } from "$lib/stores/snackbar.svelte";
	import { getLibrarySurface, searchLibrary, sendLibraryManagerMessage, updateLibraryStatus, verifyLibraryCapability, type LibraryAcquisitionReceipt, type LibraryManagerAction } from "./library-manager.remote";
	let { data } = $props();
	const libraryQuery = getLibrarySurface();
	const settlementQuery = getWorkSettlement();
	const baseLibrary = $derived(data.library.isMock ? data.library : libraryQuery.current ?? data.library);
	const historyItems = $derived((settlementQuery.current?.history ?? []).map(settledTaskLibraryItem));
	const closedTasks = $derived([...(settlementQuery.current?.settling ?? []), ...(settlementQuery.current?.history ?? [])]);
	const lib = $derived.by(() => {
		const historyIds = new Set(historyItems.map((item) => item.id));
		const taskProvenance = Object.fromEntries(closedTasks.map((task) => [`task:${String(task.id)}`, { responsibleHuman: task.owner ?? "unassigned", txFrom: task.updated_at }]));
		return { ...baseLibrary, items: [...historyItems, ...baseLibrary.items.filter((item: LibraryItemView) => !historyIds.has(item.id))], provenance: { ...baseLibrary.provenance, ...taskProvenance } };
	});
	const loadingSurface = $derived(!data.library.isMock && libraryQuery.loading && !libraryQuery.current);
	let view = $state<LibraryView>("list");
	let query = $state("");
	let kind = $state<LibraryKind|null>(null);
	let project = $state<string|null>(null); let scope = $state<string|null>(null); let creator = $state<string|null>(null); let status = $state<string|null>(null);
	let messages = $state<LibraryChatMessage[]>([]);
	let managerBusy = $state(false);
	let managerSessionId = $state<string|null>(null);
	let selected = $state<LibraryItemView|null>(null);
	let search = $state<HTMLInputElement|null>(null);
	let searchResults=$state<LibraryItemView[]|null>(null);
	let searchState=$state<"idle"|"searching"|"failed">("idle");
	let handledItem=$state<string|null>(null);
	let statusOverrides = $state<Record<string,{status:string;version:number}>>({});
	let acquisitions = $state<Record<string,{state:"loading"|"ready"|"failed";receipt?:LibraryAcquisitionReceipt;message?:string}>>({});
	const surfaceItems = $derived(lib.items.map((item) => statusOverrides[item.id] ? {...item,...statusOverrides[item.id]} : item));
	const results = $derived((searchResults??surfaceItems).filter((item) => (!kind || item.kind === kind) && (!project || item.project === project) && (!scope || item.scope === scope) && (!creator || item.creator === creator) && (!status || item.status === status) && (searchResults!==null || `${item.title} ${item.project} ${item.kind} ${item.creator}`.toLowerCase().includes(query.toLowerCase()))));
	const links=$derived(lib.links ?? libraryLinks);
	const canUpdateStatus=$derived(data.lanes.includes("editor") && lib.libraryExecutorLive === true);
	function open(item: LibraryItemView){ void goto(`/library/${encodeURIComponent(item.id)}`); }
	async function runSearch(nextQuery:string){query=nextQuery;view="table";if(lib.isMock||!nextQuery.trim()){searchResults=null;searchState="idle";return;}searchState="searching";try{searchResults=await searchLibrary({query:nextQuery});searchState="idle";}catch{searchResults=[];searchState="failed";}}
	async function submit(e:SubmitEvent){e.preventDefault();await runSearch(query);}
	function applyManagerAction(action:LibraryManagerAction){const {intent}=action;if(intent.view&&["desk","graph","kanban","table"].includes(intent.view))view=intent.view==="desk"?"list":intent.view;if(typeof intent.query==="string"){query=intent.query;searchResults=action.items;searchState="idle";view="table";}if(typeof intent.item_id==="string")selected=action.item??(searchResults??surfaceItems).find(item=>item.id===intent.item_id)??null;if(intent.focus==="curation")queueMicrotask(()=>document.querySelector<HTMLElement>(".curation")?.scrollIntoView({behavior:"smooth",block:"center"}));}
	async function ask(message:string){const userMessage:LibraryChatMessage={id:crypto.randomUUID(),role:"user",content:message};messages=[...messages,userMessage];managerBusy=true;try{const response=await sendLibraryManagerMessage({message,view:view==="list"?"desk":view,query,selected_item_id:selected?.id??null});managerSessionId=response.session_id;messages=[...messages,{id:response.message_id,role:"assistant",content:response.content}];if(response.library_action)applyManagerAction(response.library_action);}catch(error){messages=[...messages,{id:crypto.randomUUID(),role:"error",content:`The manager session could not continue. ${(error as Error).message}`}];}finally{managerBusy=false;}}
	async function moveStatus(item:LibraryItemView,next:WorkLane|KnowledgeLane){const previous=statusOverrides[item.id];statusOverrides={...statusOverrides,[item.id]:{status:next,version:item.version}};try{const result=await updateLibraryStatus({id:item.id,status:next,expected_version:item.version});statusOverrides={...statusOverrides,[item.id]:{status:result.status,version:result.version}};snackbar.push({message:result.status==="CONFLICT"?"library.item.update found a conflict · adjudication required":`library.item.update applied · ${next}`,op:"library.item.update",tone:result.status==="CONFLICT"?"warn":"good"});}catch(error){if(previous)statusOverrides={...statusOverrides,[item.id]:previous};else{const {[item.id]:_removed,...rest}=statusOverrides;statusOverrides=rest;}snackbar.push({message:`library.item.update failed: ${(error as Error).message}`,op:"library.item.update",tone:"danger"});}}
	async function verifyCapability(capability:string,provider:string){const key=`${provider}:${capability}`;acquisitions={...acquisitions,[key]:{state:"loading"}};try{const receipt=await verifyLibraryCapability({capability,provider});acquisitions={...acquisitions,[key]:{state:"ready",receipt}};snackbar.push({message:`${capability} artifact verified · agents acquire it with the loader`,op:"registry.verify",tone:"good"});}catch(error){const message=(error as Error).message;acquisitions={...acquisitions,[key]:{state:"failed",message}};snackbar.push({message:`registry.verify failed: ${message}`,op:"registry.verify",tone:"danger"});}}
	function keys(e:KeyboardEvent){ if(e.key==="f" && !(e.target instanceof HTMLInputElement)&&!(e.target instanceof HTMLSelectElement)){e.preventDefault();search?.focus();} if(["1","2","3","4"].includes(e.key)&&!(e.target instanceof HTMLInputElement)&&!(e.target instanceof HTMLSelectElement)) view=(["list","graph","kanban","table"] as const)[Number(e.key)-1]; }
	$effect(()=>{const id=page.url.searchParams.get("item");if(!id||id===handledItem)return;handledItem=id;void goto(`/library/${encodeURIComponent(id)}`,{replaceState:true});});
	$effect(()=>{if(page.url.searchParams.get("focus")!=="search")return;queueMicrotask(()=>search?.focus());});
	onMount(() => {
		const refresh = setInterval(() => void settlementQuery.refresh(), 60_000);
		return () => clearInterval(refresh);
	});
</script>
<svelte:window onkeydown={keys}/>
<div class="sign"><h1>The Library</h1><span>Everything anyone here has ever learned. Ask.</span><form onsubmit={submit} title={lib.connected?"Search the stacks":"Store unreachable"}><Icon name="search" size={14}/><input bind:this={search} bind:value={query} placeholder="Search the stacks" aria-label="Search the stacks" disabled={!lib.connected}/></form><LibraryViewSwitcher value={view} disabled={!lib.connected && !loadingSurface} onchange={(next)=>view=next}/><button class="bud" title="Budhole" aria-label="Budhole" disabled={!lib.connected}><Icon name="library" size={16}/></button></div>
{#if view==="list"}<div class="ask">
	<LibraryManagerSession {messages} busy={managerBusy} connected={data.managerConnected} isMock={lib.isMock} sessionId={managerSessionId} onask={ask}/>
</div>{/if}
{#if !lib.connected}<div class="unavailable"><Icon name="circle-help" size={18}/><div><b>The stacks are unreachable.</b><p>No current Library items are rendered. The manager remains available if its runtime is healthy.</p></div></div>{/if}
{#if lib.connected}
{#if view==="list"}
	<section class="panel work-history"><header><h2>Work history</h2><span>settled after 24h</span></header>{#if settlementQuery.error}<div class="history-error" role="status"><Icon name="triangle-alert" size={16}/><span><b>Work history unreadable.</b> {settlementQuery.current?"Showing the last honest snapshot.":"No settled tasks are shown until the source recovers."}</span><button onclick={() => settlementQuery.refresh()}>Retry</button></div>{/if}{#if settlementQuery.loading&&!settlementQuery.current}<div class="history-skeleton" aria-label="Loading work history" aria-busy="true"><span></span><span></span></div>{:else if settlementQuery.current}<div class="history-list">{#each historyItems.slice(0,4) as item (item.id)}<div class="history-arrival"><LibraryItemCard {item} compact onopen={open}/></div>{:else}<p class="empty">No completed work has reached the 24-hour settle boundary.</p>{/each}</div>{/if}<footer><Icon name="circle-check" size={12}/><span>{settlementQuery.current?.settled_this_week??"—"} settled this week · tracker projection</span></footer></section>
	<div class="desk"><main><section class="panel"><header><h2>Held for you</h2><span>the librarian set these aside</span></header><div class="two">{#each lib.items.filter(i=>i.hold?.startsWith("Held")).slice(0,2) as item}<LibraryItemCard {item} onopen={open}/>{:else}<p class="empty">Nothing held aside for you yet.</p>{/each}</div><footer><Icon name="scroll-text" size={12}/> {lib.isMock?"fixture receipt":"personal holds · 60s freshness"}</footer></section><section class="panel"><header><h2>Recommended for you</h2><span>your reading room, not a feed</span></header><div class="two">{#each lib.items.filter(i=>i.hold?.startsWith("Recommended")).slice(0,2) as item}<LibraryItemCard {item} onopen={open}/>{:else}<p class="empty">No recommendations have fresh evidence yet.</p>{/each}</div><footer><Icon name="scroll-text" size={12}/> librarian picks · reason recorded</footer></section><section class="panel"><header><h2>Readable stacks</h2><span>recent items in your scopes</span></header>{#each lib.items.slice(0,3) as item}<LibraryItemCard {item} compact onopen={open}/>{:else}<p class="empty">Your readable stacks are empty.</p>{/each}<footer><Icon name="scroll-text" size={12}/> scope-filtered by Library RLS</footer></section></main><aside><section class="panel"><header><h2>Recent arrivals</h2><span>your scopes</span></header>{#each lib.items.slice(0,3) as item}<LibraryItemCard {item} compact onopen={open}/>{/each}</section><section class="panel curation"><header><h2>Curation</h2><span>librarian · review queue</span></header><p>{lib.curation?.length??0} reviewable {lib.curation?.length===1?"proposal":"proposals"} in your scopes.</p><small>{lib.sources?.curation==="live"?"live Library curation queue":"curation source unavailable"}</small><button disabled title="Approval actions are not wired yet">Review {lib.curation?.length??0}</button></section><section class="panel registry"><header><h2>Tool registry</h2><span>{lib.sources?.capabilities==="live"?`${lib.capabilities?.filter(c=>c.fresh).length??0} fresh · ${lib.capabilities?.filter(c=>!c.fresh).length??0} stale`:"unavailable"}</span></header><div class="tool-inventory" aria-live="polite">{#each lib.capabilities??[] as capability}{@const key=`${capability.provider}:${capability.capability}`}<div class="capability"><div><code>{capability.capability}</code><small>{capability.provider}{capability.transport?` · ${capability.transport}`:""}{capability.fresh?"":" · stale"}</small>{#if acquisitions[key]?.state==="ready"}<small class="proof">SHA-256 verified · {acquisitions[key].receipt?.artifact.bytes} bytes · v{acquisitions[key].receipt?.version}</small>{:else if acquisitions[key]?.state==="failed"}<small class="failure">Artifact unavailable · {acquisitions[key].message}</small>{/if}</div><button onclick={()=>verifyCapability(capability.capability,capability.provider)} disabled={!capability.fresh||acquisitions[key]?.state==="loading"} title={capability.fresh?"Verify the runnable artifact for agent acquisition":"Registry evidence is stale"}><Icon name="package" size={14}/>{acquisitions[key]?.state==="loading"?"Checking…":acquisitions[key]?.state==="ready"?"Verified":"Verify"}</button></div>{:else}<p class="caption">No visible capabilities have registry evidence.</p>{/each}</div><footer><Icon name="scroll-text" size={12}/> scope checked · Library artifact · agents acquire with loader</footer></section><section class="panel"><header><h2>Check before web</h2></header>{#if lib.isMock}<div class="kpi">87%<small>stacks answered first</small></div><p class="caption">9 fixture web fallbacks this week.</p>{:else}<p class="caption">Hit-rate evidence is unavailable. Research egress remains disabled.</p>{/if}</section></aside></div>
{:else if view==="table"}
	<div class="facets"><span>{searchState==="searching"?"Searching the stacks…":searchState==="failed"?"Search failed · nothing pretended":`${results.length} results · ${lib.isMock?"hybrid-search fixture":searchResults!==null?"Library lexical search · dense unavailable":"local filter over scope-filtered Library items"}`}</span><button class:on={kind==="how-to"} onclick={()=>kind=kind==="how-to"?null:"how-to"}>kind: how-to</button><button class:on={project==="fleet"} onclick={()=>project=project==="fleet"?null:"fleet"}>project: fleet</button><button class:on={scope==="fleet-public"} onclick={()=>scope=scope==="fleet-public"?null:"fleet-public"}>scope: fleet-public</button><button class:on={creator==="carson-2"} onclick={()=>creator=creator==="carson-2"?null:"carson-2"}>created-by: carson-2</button><button class:on={status==="verified-shared"} onclick={()=>status=status==="verified-shared"?null:"verified-shared"}>status: verified</button></div><div class="table"><div class="head"><span>title</span><span>project</span><span>updated</span><span>conf</span></div>{#each results as item}<button class="row" onclick={()=>open(item)}><span><b>{item.title}</b><small>{item.kind} · {item.scope} · by {item.creator}</small><em>{lib.isMock?`hybrid match · dense ${item.confidence?.toFixed(2)||"—"}`:searchResults!==null?"Library lexical match · dense index unavailable":"local title and facet match · dense index unavailable"}</em></span><code>{item.project}</code><code>{item.updated}</code><code>{item.confidence?.toFixed(2)||"—"}</code></button>{:else}<div class="empty">Nothing in the stacks for that. Research is unavailable until sole egress is wired.</div>{/each}</div>
{:else if view==="kanban"}
	<LibraryKanbanView items={surfaceItems} canUpdate={canUpdateStatus} loading={loadingSurface} onopen={open} onstatus={moveStatus}/>
{:else}
	<LibraryGraphView items={surfaceItems} {links} degraded={lib.sources?.links==="unavailable"} loading={loadingSurface} onopen={open}/>
{/if}
{/if}
<style>
	.sign { display:flex; align-items:center; gap:var(--s-3); min-height:40px; }
	.sign h1 { font:400 1.0625rem var(--sign); }
	.sign>span { font:400 .875rem var(--sign); color:var(--jade-text); }
	.sign form { margin-inline-start:auto; width:320px; min-height:32px; display:flex; align-items:center; gap:var(--s-2); padding:0 var(--s-2); background:var(--s2); border-radius:var(--r-sm); }
	input { width:100%; border:0; outline:0; background:none; color:var(--text); font-size:.75rem; }
	.sign form:focus-within { box-shadow:0 0 0 2px var(--petal); }
	.bud { width:32px; min-height:32px; padding:0; border:0; border-radius:var(--r-sm); background:transparent; color:var(--text-2); }
	.bud:focus-visible { outline:2px solid var(--petal); outline-offset:2px; }
	.unavailable { display:flex; gap:var(--s-2); margin-top:var(--s-3); padding:var(--s-3); border-radius:var(--r-xs); background:var(--warn-soft); color:var(--warn-text); }
	.unavailable p { color:var(--text-2); font-size:.75rem; }
	.ask { margin:var(--s-4) 0; }
	.desk { display:grid; grid-template-columns:minmax(0,1fr) 344px; gap:var(--s-3); padding-bottom:var(--s-4); animation:view-in 120ms var(--ease-standard); }
	.desk main,.desk aside { display:flex; flex-direction:column; gap:var(--s-3); }
	.panel { padding:var(--s-3); border-radius:var(--r-xs); background:var(--s1); }
	.panel header { display:flex; align-items:baseline; gap:var(--s-2); margin-bottom:var(--s-2); }
	.panel h2 { font-size:.84375rem; }
	.panel header span { color:var(--text-3); font-size:.6875rem; }
	.panel footer { display:flex; align-items:center; gap:var(--s-2); margin-top:var(--s-2); padding-top:var(--s-2); border-top:1px solid var(--rule); color:var(--text-3); font:400 .6875rem var(--mono); }
	.two { display:grid; grid-template-columns:1fr 1fr; gap:var(--s-2); }
	.empty { padding:var(--s-3); color:var(--text-3); font-size:.8125rem; }
	.curation p { color:var(--text-2); font-size:.8125rem; }
	.curation small { display:block; margin:var(--s-2) 0; color:var(--text-3); }
	.curation button { min-height:32px; padding:0 var(--s-3); border:0; border-radius:var(--r-sm); background:var(--s2); }
	.tool-inventory { max-height:240px; overflow:auto; }
	.capability { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); min-height:56px; padding:var(--s-2) 0; border-top:1px solid var(--rule); }
	.capability:first-child { border-top:0; }
	.capability>div { min-width:0; }
	.capability code,.capability small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.capability code { color:var(--text); font-size:.75rem; }
	.capability small { color:var(--text-3); font-size:.6875rem; }
	.capability .proof { color:var(--jade-text); }
	.capability .failure { color:var(--danger-text); white-space:normal; }
	.capability button { display:flex; align-items:center; gap:var(--s-1); min-height:32px; padding:0 var(--s-2); border:0; border-radius:var(--r-sm); background:var(--petal-soft); color:var(--petal-text); font-weight:500; transition:background 140ms var(--ease-standard),opacity 140ms var(--ease-standard); }
	.capability button:hover:not(:disabled) { background:var(--petal-ln); }
	.capability button:focus-visible { outline:2px solid var(--petal); outline-offset:2px; }
	.capability button:disabled { cursor:not-allowed; opacity:.56; }
	.kpi { font:500 1.75rem var(--mono); }
	.kpi small { display:block; color:var(--text-3); font:400 .75rem var(--sans); }
	.caption { color:var(--text-3); font-size:.75rem; }
	.facets { display:flex; align-items:center; gap:var(--s-2); margin:var(--s-3) 0; overflow-x:auto; }
	.facets>span { margin-inline-end:auto; color:var(--text-3); font:400 .6875rem var(--mono); white-space:nowrap; }
	.facets button { min-height:32px; padding:0 var(--s-2); border:0; border-radius:var(--r-pill); background:var(--s2); color:var(--text-2); white-space:nowrap; }
	.facets button.on { background:var(--petal-soft); color:var(--petal-text); }
	.table { border-radius:var(--r-xs); background:var(--s1); animation:view-in 120ms var(--ease-standard); }
	.head,.row { display:grid; grid-template-columns:1fr 120px 80px 64px; gap:var(--s-2); align-items:center; }
	.head { min-height:32px; padding:0 var(--s-3); color:var(--text-3); font:500 .6875rem var(--mono); }
	.row { width:100%; min-height:64px; padding:var(--s-1) var(--s-3); border:0; border-top:1px solid var(--rule); background:none; color:var(--text); text-align:left; }
	.row:hover { background:var(--s2); }
	.row:focus-visible { outline:2px solid var(--petal); outline-offset:2px; }
	.row b,.row small,.row em { display:block; }
	.row b { font-size:.8125rem; }
	.row small,.row em { color:var(--text-3); font:400 .6875rem var(--mono); }
	.row em { margin-top:var(--s-1); color:var(--jade-text); }
	.row code { text-align:right; }
	.work-history { margin-bottom:var(--s-3); }
	.work-history footer span { min-width:0; overflow-wrap:anywhere; }
	.history-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-1); }
	.history-arrival { animation:history-arrive 240ms var(--ease-standard) both; }
	.history-error { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:var(--s-2); margin:var(--s-2); padding:var(--s-2); border-radius:var(--r-sm); background:var(--danger-soft); color:var(--danger-text); font-size:12px; line-height:1.45; }
	.history-error button { min-height:32px; padding:0 var(--s-2); border:1px solid currentColor; border-radius:var(--r-xs); background:transparent; color:var(--danger-text); font:500 11px var(--mono); cursor:pointer; }
	.history-error button:focus-visible { outline:2px solid var(--petal); outline-offset:2px; }
	.history-skeleton { display:grid; gap:var(--s-2); padding:var(--s-2); }
	.history-skeleton span { display:block; width:72%; height:10px; border-radius:var(--r-xs); background:var(--s2); animation:history-pulse 1.2s ease-in-out infinite alternate; }
	.history-skeleton span:last-child { width:52%; }
	@keyframes history-arrive { from { opacity:0; transform:translateY(-2px); } }
	@keyframes history-pulse { to { background:var(--s3); } }
	@keyframes view-in { from { opacity:.72; } }
	@media(max-width:900px) { .sign>span,.bud { display:none; } .sign form { width:220px; } .desk { grid-template-columns:1fr; } }
	@media(max-width:767px) { .sign { flex-wrap:wrap; } .sign form { order:4; width:100%; } .desk aside,.desk main .panel:not(:first-child) { display:none; } .two,.history-list { grid-template-columns:1fr; } .head,.row { grid-template-columns:1fr 56px; } .head span:nth-child(2),.head span:nth-child(4),.row>code:nth-of-type(1),.row>code:nth-of-type(3) { display:none; } }
	@media(prefers-reduced-motion:reduce) { .desk,.table,.history-arrival,.history-skeleton span { animation:none; } }
</style>
