<script lang="ts">
	import { env } from "$env/dynamic/public";
	import { invalidateAll } from "$app/navigation";
	import { onMount, untrack } from "svelte";
	import { connectBus, runOp } from "$lib/api/client";
	import type { CardItem, OpResult, TaskItem, TaskStatus } from "$lib/api/types";
	import Countdown from "$lib/components/Countdown.svelte";
	import HudChip from "$lib/components/HudChip.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import PriorityPips from "$lib/components/PriorityPips.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";
	import VerificationBadge from "$lib/components/VerificationBadge.svelte";
	import type { WorkEvent } from "$lib/data/work";
	import { snackbar } from "$lib/stores/snackbar.svelte";

	let { data } = $props();
	let tasks = $state<TaskItem[]>([...untrack(() => data.tasks)]);
	let wantedCards = $state<CardItem[]>([...untrack(() => data.wanted)]);
	let filter = $state("");
	let now = $state(Date.now());
	let selected = $state<TaskItem | null>(null);
	let drawer = $state<HTMLDialogElement | null>(null);
	let rejectReason = $state("");
	let busy = $state<number | null>(null);
	let mountedAt = $state(Date.now());
	let busHeartbeatAt = $state<string | null>(untrack(() => data.isMock) ? new Date().toISOString() : null);
	let busIngestHealthy = $state(untrack(() => data.isMock));
	let expanded = $state<Record<string, boolean>>({});
	let dragged = $state<TaskItem | null>(null);
	let blockReason = $state("");
	let closeReason = $state("");
	let dispatchRecipient = $state("");
	const statuses: { id: Exclude<TaskStatus, "done" | "dropped">; label: string }[] = [
		{ id: "inbox", label: "Inbox" }, { id: "todo", label: "Todo" }, { id: "doing", label: "Doing" },
		{ id: "review", label: "Review" }, { id: "blocked", label: "Blocked" },
	];
	const visible = $derived(tasks.filter((task) => `${task.title} ${task.project_title} ${task.assignee} ${task.claimed_by}`.toLowerCase().includes(filter.toLowerCase())));
	const ackedReviewTaskIds = $derived(new Set<number>(data.ackedReviewTaskIds as number[]));
	const reviewReady = $derived(tasks.filter((task) => task.status === "review" && (task.verification_status ?? "unverified") === "unverified" && !ackedReviewTaskIds.has(task.id)));
	const inFlight = $derived(tasks.filter((task) => task.status === "doing" || task.status === "review"));
	const unclaimed = $derived(wantedCards.filter((card: CardItem) => card.state === "posted" || card.state === "parked" || card.state === "dead"));
	const done = $derived(tasks.filter((task) => task.status === "done" && now - Date.parse(task.updated_at) < 864e5));
	const busSilent = $derived(!data.isMock && (!busIngestHealthy || (busHeartbeatAt ? now - Date.parse(busHeartbeatAt) > 9e4 : now - mountedAt > 9e4)));
	const stale = $derived(!data.tasksAvailable || !data.snapshotAt || (busSilent && now - Date.parse(data.snapshotAt) > 9e4));
	const canAct = $derived(data.lanes.includes("operator") && !stale);
	const p0 = $derived(tasks.find((task) => task.priority === 0 && !task.claimed_by && task.status !== "done" && task.status !== "dropped"));
	const leaseFor = (id: number) => data.leases.find((lease: { task_id: number }) => lease.task_id === id);
	const eventsFor = (id: number): WorkEvent[] => data.events.filter((event: WorkEvent) => event.taskId === id);
	const age = (value: number | string) => { const ms = typeof value === "number" ? value : Date.parse(value); const minutes = Math.max(0, Math.round((now - ms) / 6e4)); return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`; };
	const score = (card: CardItem) => (3 - card.priority) + .05 * ((now - card.created_at_ms) / 6e4);
	const rank = (state: CardItem["state"]) => state === "posted" ? 0 : state === "parked" ? 1 : state === "dead" ? 2 : 3;
	const wanted = $derived(wantedCards.toSorted((a: CardItem, b: CardItem) => {
		return rank(a.state) - rank(b.state) || score(b) - score(a);
	}));
	async function runTaskClose(args: Record<string, unknown>, dryRun = false): Promise<OpResult> {
		const response = await fetch(`${env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1"}/op`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			credentials: "include",
			body: JSON.stringify({ schema_version: 1, id: crypto.randomUUID(), op: "task.close", args, task_id: args["id"], reason: args["reason"], dry_run: dryRun }),
		});
		const body = await response.json() as OpResult & { error?: { code?: string; message?: string } | null };
		if (!response.ok) {
			const error = new Error(body.error?.message ?? `task.close failed (${response.status})`) as Error & { code?: string };
			error.code = body.error?.code;
			throw error;
		}
		return body;
	}

	$effect(() => { if (selected && drawer && !drawer.open) drawer.showModal(); });
	$effect(() => {
		if (data.isMock) return;
		tasks = [...data.tasks]; wantedCards = [...data.wanted];
		if (selected) selected = data.tasks.find((task: TaskItem) => task.id === selected?.id) ?? null;
	});
	onMount(() => {
		const clock = setInterval(() => now = Date.now(), 1000);
		if (data.isMock) return () => clearInterval(clock);
		const disconnect = connectBus(
			() => ["task.**", "card.**", "artifact.**"].map((pattern, index) => ({ sub_id: `console-work-${index}`, pattern })),
			(rawFrame) => {
				const frame = rawFrame as { kind?: string; ts?: string; ingest?: Record<string, number> | null; emission?: { type?: string } };
				if (frame.kind === "heartbeat") {
					busHeartbeatAt = frame.ts ?? new Date().toISOString();
					const lags = frame.ingest ? Object.values(frame.ingest) : [];
					busIngestHealthy = lags.length > 0 && lags.every((lag) => lag <= 90);
				}
				if (frame.kind === "event" && /^(task|card|artifact)\./.test(frame.emission?.type ?? "")) void invalidateAll();
				if (frame.kind === "gap" || frame.kind === "resync_required") void invalidateAll();
			},
			(state) => { if (state === "error" || state === "closed") busIngestHealthy = false; },
		);
		return () => { clearInterval(clock); disconnect(); };
	});

	async function fire(task: TaskItem, op: string, args: Record<string, unknown>, patch?: Partial<TaskItem>, message?: string) {
		busy = task.id;
		try {
			let resolvedArgs = args;
			// The command router resolves the target's current ReBAC relation. Permission-level names
			// are data, so the browser must not maintain an owner/moderator allowlist for force writes.
			if ((op === "task.update" || op === "task.close") && !data.isMock) {
				const { force: _requestedForce, ...preflightArgs } = args;
				const preflight = op === "task.close" ? await runTaskClose(preflightArgs, true) : await runOp(op, preflightArgs, { dry_run: true });
				const capabilities = preflight.result?.["capabilities"];
				if (args["force"] === true && (!capabilities || typeof capabilities !== "object" || !(capabilities as Record<string, unknown>)["force"]))
					resolvedArgs = preflightArgs;
			}
			if (!data.isMock) {
				if (op === "task.close") await runTaskClose(resolvedArgs);
				else await runOp(op, resolvedArgs);
			}
			if (data.isMock && patch) {
				tasks = tasks.map((item) => item.id === task.id ? { ...item, ...patch, updated_at: new Date().toISOString() } : item);
				if (selected?.id === task.id) selected = { ...selected, ...patch };
			} else if (!data.isMock) await invalidateAll();
			snackbar.push({ message: message ?? `${op} sent`, op, tone: "good" });
		} catch (error) {
			const apiError = error as Error & { code?: string };
			snackbar.push({ message: apiError.code === "claim_lost" ? "Claimed by another resident first." : `${op} failed: ${apiError.message}`, op, tone: apiError.code === "claim_lost" ? "warn" : "danger" });
		} finally { busy = null; }
	}
	const claim = (task: TaskItem) => fire(task, "task.claim", { id: task.id, ...(task.capability ? { capability: task.capability } : {}) }, { status: "doing", claimed_by: "you", assignee: "you" }, "task.claim won. Lease pending server projection.");
	const dispatch = (task: TaskItem, recipient = task.suggested_agent ?? "") => fire(task, "task.dispatch", { task_id: task.id, ...(recipient ? { recipient } : {}), body: task.body || task.title, priority: task.priority, needs: task.capability ? [task.capability] : [], interrupt_policy: "defer" }, undefined, `task.dispatch sent${recipient ? ` to ${recipient}` : " to pool"}`);
	const verify = (task: TaskItem) => fire(task, "task.update", { id: task.id, patch: { verification_status: "verified", status: "done" }, force: true }, { verification_status: "verified", status: "done" }, "task.update: verified. Done. Points posted.");
	const reject = (task: TaskItem) => fire(task, "task.update", { id: task.id, patch: { verification_status: "rejected", status: "todo", body: `${task.body ?? ""}\n\nReview rejection: ${rejectReason}`.trim() }, force: true }, { verification_status: "rejected", status: "todo" }, "task.update: rejected. Back to todo.");
	const moveTodo = (task: TaskItem) => fire(task, "task.update", { id: task.id, patch: { status: "todo" } }, { status: "todo" });
	const move = (task: TaskItem, status: Exclude<TaskStatus,"done"|"dropped">) => fire(task, "task.update", { id: task.id, patch: { status }, ...((task.status === "doing" || task.status === "review") ? { force: true } : {}) }, { status });
	const block = (task: TaskItem) => fire(task, "task.update", { id: task.id, patch: { status: "blocked", blocked_on: blockReason }, ...((task.status === "doing" || task.status === "review") ? { force: true } : {}) }, { status: "blocked", blocked_on: blockReason });
	const close = (task: TaskItem) => fire(task, "task.close", { id: task.id, status: "done", reason: closeReason.trim(), ...((task.status === "doing" || task.status === "review") ? { force: true } : {}) }, { status: "done", close_reason: closeReason.trim() }, "task.close: done with reason recorded.");
	async function claimWanted(card: CardItem) {
		const task = tasks.find((item) => item.id === card.task_id) ?? { id: card.task_id, title: card.body, status: "todo", priority: card.priority, kind: "task", created_at: new Date(card.created_at_ms).toISOString(), updated_at: new Date(card.updated_at_ms).toISOString() } satisfies TaskItem;
		await claim(task);
		if (data.isMock) { wantedCards = wantedCards.filter((item) => item.card_id !== card.card_id); if (!tasks.some((item)=>item.id===task.id)) tasks = [...tasks, { ...task, status: "doing", claimed_by: "you", assignee: "you" }]; }
	}
	function keys(event: KeyboardEvent) {
		if (event.key === "Escape" && drawer?.open) drawer.close();
		const cards = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-task-card]"));
		const index = cards.indexOf(event.target as HTMLButtonElement);
		if (index >= 0 && ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) {
			event.preventDefault(); const next = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
			cards[Math.max(0, Math.min(cards.length - 1, index + next))]?.focus();
		}
	}
</script>

<svelte:window onkeydown={keys}/>
<header class="utility"><div class="surface-sign"><h1>Work</h1><span>What We Owe</span><small class:danger={p0} class:warn={stale}>{p0 ? `Everything is not fine. P0 unclaimed ${age(p0.updated_at)}.` : stale ? "Can't verify. Task snapshot stale." : "Welcome! Everything is fine."}</small></div><label><Icon name="search" size={14}/><input bind:value={filter} placeholder="Filter work" aria-label="Filter work"/></label><time>{new Date(now).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})}</time></header>
<div class="hud"><HudChip tone={reviewReady.length ? "warn" : "idle"} count={data.attentionAvailable?reviewReady.length:"—"} label="need review"/><HudChip tone="good" count={inFlight.length} label="in flight"/><HudChip tone={wantedCards.some((card: CardItem)=>card.state==="parked"||card.state==="dead")?"warn":"idle"} count={unclaimed.length} label="unclaimed"/></div>
{#if stale}<div class="stalebar"><Icon name="triangle-alert" size={14}/> STALE · task snapshot is unavailable or older than 90s · state actions blocked</div>{/if}

{#snippet taskCard(task: TaskItem)}
	{@const lease = leaseFor(task.id)}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<article class="task" class:urgent={task.priority===0} class:ready={task.status==="review"&&task.verification_status!=="verified"&&!ackedReviewTaskIds.has(task.id)} draggable="true" ondragstart={() => dragged=task}>
		<button class="drill" data-task-card data-status={task.status} onclick={() => { selected=task; rejectReason=""; blockReason=task.blocked_on??""; closeReason=""; dispatchRecipient=task.suggested_agent??""; }}><span class="title">{task.title}</span>{#if task.project_title}<span class="project">{task.project_title}</span>{/if}</button>
		{#if task.claimed_by || task.assignee}<div class="agent"><span>{(task.claimed_by||task.assignee)?.slice(0,1).toUpperCase()}</span><b>{task.claimed_by||task.assignee}</b></div>{:else if task.suggested_agent}<small>suggested: {task.suggested_agent}</small>{/if}
		{#if (task.status==="doing"||task.status==="review") && (task.lease_expires_at||lease)}<div class="lease"><Icon name="timer" size={12}/><Countdown expiresAt={lease?.lease_expires_at??task.lease_expires_at??null} {now}/><code>fence {lease?.fence??"—"}</code></div>{/if}
		{#if task.status==="blocked"}<small class="blocked">blocked · {task.blocked_on||"reason missing"}</small>{/if}
		<footer><PriorityPips priority={task.priority}/><VerificationBadge status={task.verification_status??"unverified"} word={false}/><span></span>{#if task.priority===0 && (task.status==="todo"||task.status==="inbox")}<button class="mini tonal" disabled={!canAct||busy===task.id||!data.dispatcherLive} title={!canAct?"state actions blocked":!data.dispatcherLive?"dispatcher unreachable":"task.dispatch"} onclick={() => dispatch(task)}>Dispatch</button>{#if task.status==="todo"}<button class="mini" disabled={!canAct||busy===task.id||!data.trackerLive} title={!canAct?"state actions blocked":!data.trackerLive?"tracker unreachable":"task.claim"} onclick={() => claim(task)}>Claim</button>{/if}{/if}{#if task.status==="review"}<button class="mini tonal" disabled={!canAct||busy===task.id||!data.trackerLive} title={!canAct?"task.update permission required":"task.update"} onclick={() => verify(task)}>Verify</button><button class="mini" disabled={!canAct||busy===task.id||!data.trackerLive} title={!canAct?"task.update permission required":"Reject with reason"} onclick={() => { selected=task; rejectReason=""; }}>Reject</button>{/if}</footer>
	</article>
{/snippet}

<section class="board" aria-label="Task board">{#each statuses as column}<div class="column status-{column.id}" class:review={column.id==="review"} role="list" aria-label={column.label} ondragover={(event)=>event.preventDefault()} ondrop={() => { if(dragged&&canAct) void move(dragged,column.id); dragged=null; }}><header title={column.id==="blocked"?"Blocked means waiting on a person or a fact. Say which.":undefined}><span>{column.label}</span><b>{visible.filter((task)=>task.status===column.id).length}</b></header>{#each visible.filter((task)=>task.status===column.id).sort((a,b)=>(a.priority-b.priority)||(a.rank??0)-(b.rank??0)).slice(0,expanded[column.id]?undefined:12) as task (task.id)}{@render taskCard(task)}{:else}<p>{column.id==="inbox"?"Inbox zero. You owe nothing right now.":"All caught up."}</p>{/each}{#if visible.filter((task)=>task.status===column.id).length>12}<button class="more" onclick={()=>expanded[column.id]=!expanded[column.id]}>{expanded[column.id]?"Show less":`${visible.filter((task)=>task.status===column.id).length-12} more`}</button>{/if}</div>{/each}</section>

<section class="settle"><header><Icon name="circle-check" size={14}/><h2>Done today</h2><span>Settles to the Library after 24h.</span></header>{#each done as task}<button onclick={()=>{selected=task;blockReason="";closeReason="";dispatchRecipient="";}}><Icon name="circle-check" size={14}/><b>{task.title}</b><span>{task===done[0]?"Done. Points posted.":""}</span><time>settles in {Math.max(0,24-Math.round((now-Date.parse(task.updated_at))/36e5))}h</time></button>{:else}<p>All caught up.</p>{/each}</section>

<div class="lower"><section class="wanted"><header><Icon name="signpost" size={14}/><h2>Unclaimed work</h2><span>Soul Squad Board</span><b>{unclaimed.length}</b></header>{#each wanted as card}<article class:parked={card.state==="parked"} class:dead={card.state==="dead"}><div><b>{card.body}</b><small>{#each card.needs as need}<code>{need}</code>{/each}<span>P{card.priority}</span><span>{age(card.created_at_ms)} old</span>{#if card.state==="parked"}<em>Parked. No resident provides {card.needs.join(", ")} right now.</em>{/if}{#if card.state==="dead"}<em>{card.reaps} reaps · dead letter</em>{/if}</small></div><span class="score">score {score(card).toFixed(1)}</span>{#if card.state==="posted"}<button class="tonal" disabled={!canAct||!data.trackerLive} onclick={() => claimWanted(card)}>Claim</button>{:else if card.state==="dead"}<a href="/signals">triage in Signals</a>{:else}<button disabled title="No resident currently satisfies this card">Claim</button>{/if}</article>{:else}<p>Nothing unclaimed. The Soul Squad got it all.</p>{/each}{#if !data.wantedAvailable}<p class="unavailable">Dispatcher card projection unavailable.</p>{/if}</section>
	<aside class="feed"><header><Icon name="hammer" size={14}/><h2>Build feed</h2><span>newest {data.feed.length}</span></header>{#each data.feed as item}<article class:failed={item.state==="failed"}><div class="preview"><Icon name={item.state==="shipped"?"image":"hammer"} size={24}/></div><b>{item.title}</b><p>{item.state==="building"?"Building.":item.state==="failed"?`Build failed at ${item.step}. Log attached. Not fine until it is green.`:"Shipped to the Library."}</p><footer><span>{item.agent}</span>{#if item.taskId>0}<a href={`/work?task=${item.taskId}`}>/task/{item.taskId}</a>{:else}<span>Library artifact</span>{/if}<time>{age(item.updatedAt)}</time></footer></article>{:else}<p>{data.feedAvailable?"No recent Library artifacts.":"Build feed unavailable: Library could not be read."}</p>{/each}</aside>
</div>

<dialog bind:this={drawer} aria-labelledby="task-title" onclose={()=>selected=null}>{#if selected}<button class="x" aria-label="Close task" autofocus onclick={()=>drawer?.close()}><Icon name="x" size={16}/></button><small>/task/{selected.id} · {selected.status}</small><h2 id="task-title">{selected.title}</h2><div class="drawer-meta"><StatusPill tone={selected.status==="done"?"good":selected.status==="blocked"?"danger":selected.status==="review"?"warn":"info"} label={selected.status}/><PriorityPips priority={selected.priority}/><VerificationBadge status={selected.verification_status??"unverified"}/></div>{#if selected.claimed_by||selected.assignee}<div class="agent large"><span>{(selected.claimed_by||selected.assignee)?.slice(0,1).toUpperCase()}</span><b>{selected.claimed_by||selected.assignee}</b></div>{/if}{#if selected.acceptance_criteria}<section><h3>Acceptance criteria</h3>{#each selected.acceptance_criteria.split("\n").filter(Boolean) as criterion}<p><Icon name="circle-dashed" size={12}/>{criterion}</p>{/each}</section>{/if}{#if selected.handoff_context}<section><h3>Handoff context</h3><div class="box">{selected.handoff_context}</div></section>{/if}<section><h3>Events</h3>{#each eventsFor(selected.id) as event}<p class="event"><time>{new Date(event.ts).toLocaleTimeString()}</time><span>{event.detail}</span></p>{:else}<p>No contracted events found.</p>{/each}</section>{#if selected.result_summary}<section><h3>Result</h3><div class="box">{selected.result_summary}</div></section>{/if}<div class="drawer-actions">{#if selected.status==="review"}<button class="tonal" disabled={!canAct||!data.trackerLive} title={!canAct?"task.update permission required":"task.update"} onclick={()=>verify(selected!)}>Verify</button><label>Rejection reason<input bind:value={rejectReason}/></label><button disabled={!canAct||!data.trackerLive||!rejectReason.trim()} title={!canAct?"task.update permission required":"Reject with reason"} onclick={()=>reject(selected!)}>Reject</button>{/if}{#if selected.status==="todo"}<button class="tonal" disabled={!canAct||!data.trackerLive} onclick={()=>claim(selected!)}>Claim</button>{/if}{#if selected.status==="todo"||selected.status==="inbox"}<label>Dispatch recipient<input bind:value={dispatchRecipient} placeholder="agent id"/></label><button disabled={!canAct||!data.dispatcherLive} title={!data.dispatcherLive?"Dispatcher unreachable":"task.dispatch"} onclick={()=>dispatch(selected!,dispatchRecipient)}>Dispatch</button>{/if}{#if selected.status==="inbox"}<button class="tonal" disabled={!canAct||!data.trackerLive} onclick={()=>moveTodo(selected!)}>Move to Todo</button>{/if}{#if selected.status!=="done"&&selected.status!=="dropped"}<label>Block reason<input bind:value={blockReason} placeholder="Dependency or incident"/></label><button disabled={!blockReason.trim()||!data.trackerLive||!canAct} title={!blockReason.trim()?"A blocking reason is required":!canAct?"task.update permission required":"task.update"} onclick={()=>block(selected!)}>Block</button><label>Close reason<input bind:value={closeReason} placeholder="Outcome and why this is complete"/></label><button class="tonal" disabled={!closeReason.trim()||!data.trackerLive||!canAct||busy===selected.id} title={!closeReason.trim()?"A close reason is required":!canAct?"task.close permission required":"task.close"} onclick={()=>close(selected!)}>Close as done</button>{/if}</div>{/if}</dialog>

<style>
	.utility{display:flex;align-items:center;gap:var(--s-3);min-height:40px}.utility :global(.surface-sign){flex:1}.utility label{width:240px;height:32px;background:var(--s2);display:flex;align-items:center;gap:var(--s-2);padding:0 var(--s-2);border-radius:var(--r-xs)}input{border:0;background:none;color:var(--text);outline:0;min-width:0;width:100%}input:focus{outline:2px solid var(--petal);outline-offset:2px}.utility time{font:400 .75rem var(--mono);color:var(--text-3)}.hud{display:flex;gap:var(--s-2);margin:var(--s-3) 0 var(--s-4)}.stalebar{display:flex;align-items:center;gap:var(--s-2);min-height:40px;padding:0 var(--s-3);background:var(--warn-soft);color:var(--warn-text);font-size:.75rem;margin-bottom:var(--s-3);border-radius:var(--r-xs)}.board{display:grid;grid-template-columns:repeat(5,minmax(184px,1fr));gap:var(--s-2);min-height:320px}.column{display:flex;flex-direction:column;gap:var(--s-2);min-width:0}.column>header{height:24px;display:flex;align-items:center;gap:var(--s-1);font:500 .6875rem var(--mono);text-transform:uppercase;color:var(--text-3)}.column>header b{font-weight:500}.column>p,.settle>p,.wanted>p,.feed>p{font-size:.75rem;color:var(--text-3);padding:var(--s-2)}.task{background:var(--s1);border-radius:var(--r-xs);padding:var(--s-2);display:flex;flex-direction:column;gap:var(--s-1);transition:background var(--t),transform var(--dur-fast)}.task:hover{background:var(--s2)}.task:active{transform:scale(.97)}.task.urgent{background:var(--danger-soft)}.task.ready{background:var(--jade-soft)}.drill{border:0;background:none;color:var(--text);padding:0;text-align:left;display:flex;gap:var(--s-1);align-items:baseline}.drill:focus{outline:2px solid var(--petal);outline-offset:2px}.title{font:500 .84375rem/1.35 var(--sans);display:-webkit-box;line-clamp:2;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.project{font:500 .625rem var(--mono);text-transform:uppercase;background:var(--s2);color:var(--text-3);padding:1px var(--s-1);border-radius:var(--r-xs)}.task small{font:400 .6875rem var(--mono);color:var(--text-3)}.agent{display:inline-flex;align-items:center;gap:var(--s-1);font-size:.75rem}.agent>span{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;background:var(--jade-soft);color:var(--jade-text);font-size:.6875rem}.agent b{font-weight:500}.lease{display:flex;align-items:center;gap:var(--s-1);font-size:.6875rem;color:var(--text-3)}.lease code{margin-left:auto}.blocked{color:var(--danger-text)!important}.task footer{display:flex;align-items:center;gap:var(--s-2)}.task footer>span{flex:1}.mini,.tonal,.drawer-actions button,.wanted article>button{border:0;background:none;color:var(--text);min-height:24px;padding:0 var(--s-2);border-radius:var(--r-xs);font:500 .6875rem var(--sans)}.tonal,.mini.tonal{background:var(--petal-soft);color:var(--petal-text)}button:disabled{opacity:.45}.settle{margin-top:var(--s-4)}.settle>header,.wanted>header,.feed>header{height:32px;display:flex;align-items:center;gap:var(--s-2)}.settle h2,.wanted h2,.feed h2{font:500 .6875rem var(--mono);text-transform:uppercase}.settle header span,.wanted header span,.feed header span{font-size:.6875rem;color:var(--text-3)}.settle header span{margin-left:auto}.settle>button{width:100%;min-height:32px;border:0;border-top:1px solid var(--rule);background:none;color:var(--text);display:grid;grid-template-columns:16px 1fr 160px 100px;align-items:center;text-align:left;gap:var(--s-2)}.settle>button span{font-size:.6875rem;color:var(--text-3)}.settle>button time{text-align:right;font:400 .6875rem var(--mono)}.lower{display:grid;grid-template-columns:minmax(0,1fr) 344px;gap:var(--s-4);margin-top:var(--s-5)}.wanted,.feed{background:var(--s1);border-radius:var(--r-xs);padding:var(--s-3)}.wanted header b{margin-left:auto;font:500 .6875rem var(--mono)}.wanted article{min-height:56px;border-top:1px solid var(--rule);display:flex;align-items:center;gap:var(--s-2)}.wanted article>div{display:grid;flex:1}.wanted article small{display:flex;align-items:center;gap:var(--s-2);font:400 .6875rem var(--mono);color:var(--text-3);flex-wrap:wrap}.wanted code{background:var(--s2);padding:1px var(--s-1)}.wanted em{flex-basis:100%;font-style:normal}.wanted .parked{color:var(--text-3)}.wanted .dead{color:var(--danger-text)}.score{font:400 .6875rem var(--mono);color:var(--text-3)}.wanted a{font-size:.6875rem;color:var(--petal-text)}.unavailable{color:var(--danger-text)!important}.feed article{padding:var(--s-2) 0;border-top:1px solid var(--rule)}.preview{height:120px;background:var(--s2);display:grid;place-items:center;border-radius:var(--r-xs);color:var(--text-3);margin-bottom:var(--s-2)}.feed article>p{font-size:.75rem;color:var(--text-3)}.feed .failed>p{color:var(--danger-text)}.feed footer{display:flex;gap:var(--s-2);font-size:.6875rem}.feed footer time{margin-left:auto;font-family:var(--mono)}.feed a{color:var(--petal-text)}dialog{position:fixed;inset:0 0 0 auto;width:420px;max-width:calc(100% - 24px);height:100dvh;max-height:none;margin:0;border:0;border-left:1px solid var(--rule);background:var(--s1);color:var(--text);padding:var(--s-4);overflow:auto}dialog::backdrop{background:rgba(12,10,8,.2)}dialog .x{position:absolute;right:var(--s-3);top:var(--s-3);border:0;background:none;color:var(--text)}dialog>small{font:400 .6875rem var(--mono);color:var(--text-3)}dialog h2{font:500 1.125rem var(--sans);margin:var(--s-2) var(--s-5) var(--s-3) 0}.drawer-meta{display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap}.agent.large{margin-top:var(--s-3)}dialog section{margin-top:var(--s-4)}dialog h3{font:500 .6875rem var(--mono);text-transform:uppercase;color:var(--text-3);margin-bottom:var(--s-2)}dialog section>p{display:flex;gap:var(--s-2);font-size:.75rem}.box{background:var(--s2);padding:var(--s-3);font-size:.8125rem;border-radius:var(--r-xs)}.event{border-top:1px solid var(--rule);padding:var(--s-2) 0;margin:0}.event time{width:72px;font-family:var(--mono);color:var(--text-3)}.drawer-actions{display:flex;gap:var(--s-2);align-items:end;margin-top:var(--s-4);flex-wrap:wrap}.drawer-actions label{display:grid;font-size:.6875rem;color:var(--text-3);flex:1}.drawer-actions input{height:32px;background:var(--s2);padding:0 var(--s-2)}.contract-note{font-size:.6875rem;color:var(--text-3);margin-top:var(--s-3)}@media(max-width:1023px){.board{display:flex;flex-direction:column}.column.review{order:-5}.column{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.column>header{grid-column:1/-1}.lower{grid-template-columns:1fr}}@media(max-width:767px){.utility :global(.surface-sign) :global(.blurb),.utility time{display:none}.utility{flex-wrap:wrap}.utility label{width:100%;order:2}.utility label input{width:100%}.hud{overflow:auto}.board .column{grid-template-columns:1fr}.column:not(.review):not(:has(.urgent)){display:none}.settle>button{grid-template-columns:16px 1fr 80px}.settle>button span{display:none}.lower{margin-top:var(--s-4)}dialog{width:100%;max-width:100%}}
	.surface-sign{display:flex;align-items:baseline;gap:var(--s-3);flex:1}.surface-sign h1{font:400 1.25rem var(--sign)}.surface-sign>span{font:400 1.0625rem var(--sign);color:var(--jade-text)}.surface-sign small{font-size:.6875rem;color:var(--jade-text)}.surface-sign small.danger{color:var(--danger-text)}.surface-sign small.warn{color:var(--warn-text)}.title{line-clamp:2}
	@media(max-width:1023px){.status-review{order:1}.status-doing{order:2}.status-todo{order:3}.status-blocked{order:4}.status-inbox{order:5}}
</style>
