#!/usr/bin/env node
// Tests for the agent-API (bearer-token RPC, POST /api/agent/rpc) against a TEMP DB.
//
// No vitest in this project → a dependency-free node assertion script (same pattern as
// guard-public-share.mjs), wired to `pnpm test:agent-api`. It drives the REAL handler
// (src/lib/server/agent-api.js handleAgentRpc — the route is a thin transport wrapper)
// and the REAL db.js helpers, on a throwaway SQLite file. Never touches the live DB.
//
// Coverage (spec §5): token round-trip; revoked token rejected; out-of-scope reads
// filtered; out-of-scope get/update/close → generic 404; claim confined to scope;
// file forced into scope; unknown op → 400; missing/garbage bearer → 401; writes go
// through canonical helpers (blocked-guard + cascade-unblock + events preserved);
// scoped reap; blocker edges (add/remove/list, cycle + scope guards) and set_type;
// rate limit; token never appears in logs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// temp DB MUST be set before db.js is imported (it opens the file at import time)
const TMP = mkdtempSync(join(tmpdir(), 'agent-api-test-'));
process.env.TASKS_DB_PATH = join(TMP, 'tasks.db');

const DB = await import('../src/lib/server/db.js');
const db = DB.default;
const {
  mintAgentToken, verifyAgentToken, revokeAgentToken,
  ensureProject, createTask, updateTask, getTask, addBlocker, closeTask,
} = DB;
const { handleAgentRpc, _resetRateLimiter, BODY_MAX } = await import('../src/lib/server/agent-api.js');

// ── harness ──────────────────────────────────────────────────────────────────
const checks = [];
function t(name, fn) {
  try { fn(); checks.push({ name, pass: true }); }
  catch (e) { checks.push({ name, pass: false, detail: e.message }); }
}
// capture the handler's audit lines (and later prove no token ever leaked into them)
const logLines = [];
const rpc = (token, op, args = {}) => {
  const orig = console.log;
  console.log = (...a) => logLines.push(a.join(' '));
  try {
    return handleAgentRpc({
      authorization: token == null ? undefined : `Bearer ${token}`,
      rawBody: JSON.stringify({ op, args }),
    });
  } finally { console.log = orig; }
};

// ── fixtures ─────────────────────────────────────────────────────────────────
const secops = ensureProject('secops');     // the sensitive lane agent-b must never see
const scoutlab = ensureProject('scoutlab'); // agent-b's lane

const mk = (title, { project_id, assignee = '', status = 'todo', up_next = 0, priority = 2, rank = 0, kind = 'task' } = {}) => {
  const id = createTask({ title, kind, project_id, priority, rank, up_next, status });
  if (assignee || status !== 'todo') updateTask(id, { ...(assignee ? { assignee } : {}), ...(status !== 'todo' ? { status } : {}) });
  return id;
};

// P0 + rank 0 so it would ALWAYS win an unscoped up_next/claim — the honeypot.
const SECRET = mk('P0 secret security finding', { project_id: secops, assignee: 'agent-a', up_next: 1, priority: 0, rank: 0 });
const MINE = mk('agent-b task one', { project_id: scoutlab, assignee: 'agent-b', up_next: 1, priority: 2, rank: 5 });
const DOING = mk('agent-b in progress', { project_id: scoutlab, assignee: 'agent-b', status: 'doing' });
const Q = mk('agent-b open question', { project_id: scoutlab, assignee: 'agent-b', kind: 'question' });
const SAMEASG_OTHERPROJ = mk('agent-b-assigned but in secops', { project_id: secops, assignee: 'agent-b', up_next: 1 });
const OTHERASG_MYPROJ = mk('agent-a-assigned in scoutlab', { project_id: scoutlab, assignee: 'agent-a', up_next: 1 });

const agent-b = mintAgentToken({ agent_name: 'agent-b', scope_assignee: 'agent-b', scope_projects: 'scoutlab', readonly: false });
const full = mintAgentToken({ agent_name: 'agent-a-test', readonly: false });                       // unscoped (sanity)
const projOnly = mintAgentToken({ agent_name: 'agent-b-proj', scope_projects: ['scoutlab'], readonly: false });
const asgOnly = mintAgentToken({ agent_name: 'agent-b-asg', scope_assignee: 'agent-b', readonly: false });

_resetRateLimiter();

// ── 1. token round-trip / revocation / mint validation ──────────────────────
t('mint returns plaintext once; verify resolves identity + parsed scopes', () => {
  const v = verifyAgentToken(agent-b.token);
  // scope_readonly added with the read-only axis; asserted here so the identity SHAPE
  // stays pinned rather than loosened to a subset match.
  assert.deepEqual(v, { agent_name: 'agent-b', scope_assignee: 'agent-b', scope_projects: ['scoutlab'], scope_readonly: false });
  const row = db.prepare('SELECT * FROM agent_tokens WHERE id=?').get(agent-b.id);
  assert.ok(row.last_used_at, 'last_used_at stamped on verify');
  assert.notEqual(row.token_sha256, agent-b.token, 'plaintext is not what is stored');
  assert.equal(row.token_sha256.length, 64, 'stored value is a sha256 hex digest');
});
t('verify fails closed on garbage / empty / non-string', () => {
  assert.equal(verifyAgentToken('definitely-not-a-token'), null);
  assert.equal(verifyAgentToken(''), null);
  assert.equal(verifyAgentToken(null), null);
});
t('revoked token (by id) no longer verifies and RPC rejects it with 401', () => {
  const tmp = mintAgentToken({ agent_name: 'tmp', readonly: false });
  assert.ok(verifyAgentToken(tmp.token));
  assert.equal(revokeAgentToken(tmp.id), 1);
  assert.equal(verifyAgentToken(tmp.token), null);
  assert.equal(rpc(tmp.token, 'get_ready').status, 401);
});
t('revoke by agent_name kills all of that agent\'s live tokens', () => {
  const a = mintAgentToken({ agent_name: 'multi', readonly: false });
  const b = mintAgentToken({ agent_name: 'multi', readonly: false });
  assert.equal(revokeAgentToken('multi'), 2);
  assert.equal(verifyAgentToken(a.token), null);
  assert.equal(verifyAgentToken(b.token), null);
});
t('mint refuses an accidentally-unscoped token (supplied-but-empty scope)', () => {
  // readonly is passed explicitly on every one of these: without it they would throw on
  // the MISSING FLAG rather than the empty scope, stay green, and stop testing scope.
  assert.throws(() => mintAgentToken({ agent_name: 'x', scope_projects: '', readonly: false }), /scope_projects/);
  assert.throws(() => mintAgentToken({ agent_name: 'x', scope_projects: ' , ', readonly: false }), /scope_projects/);
  assert.throws(() => mintAgentToken({ agent_name: 'x', scope_assignee: '  ', readonly: false }), /scope_assignee/);
  assert.throws(() => mintAgentToken({ agent_name: '', readonly: false }), /agent_name/);
});

// ── 2. auth gate: missing/garbage bearer → 401, generic body ────────────────
t('missing Authorization header → 401 {error:unauthorized}', () => {
  const r = rpc(null, 'get_ready');
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'unauthorized' });
});
t('garbage bearer → 401; non-Bearer scheme → 401 (identical generic bodies)', () => {
  const g = rpc('not-a-real-token', 'get_ready');
  assert.equal(g.status, 401);
  const b = handleAgentRpc({ authorization: 'Basic dXNlcjpwdw==', rawBody: '{"op":"get_ready"}' });
  assert.equal(b.status, 401);
  assert.deepEqual(g.body, b.body);
});

// ── 3. protocol: unknown op / bad json / oversized body ──────────────────────
t('unknown op → 400', () => {
  const r = rpc(agent-b.token, 'drop_all_tables');
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'unknown_op' });
  assert.equal(rpc(agent-b.token, undefined).status, 400); // missing op
});
t('malformed JSON body → 400', () => {
  const r = handleAgentRpc({ authorization: `Bearer ${agent-b.token}`, rawBody: '{nope' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'bad_json' });
});
t('oversized body → 413', () => {
  const r = handleAgentRpc({
    authorization: `Bearer ${agent-b.token}`,
    rawBody: JSON.stringify({ op: 'file', args: { title: 'x'.repeat(BODY_MAX + 1) } }),
  });
  assert.equal(r.status, 413);
});

// ── 4. scoped reads: out-of-scope rows are filtered, filters can't widen ─────
t('get_ready (scoped): returns ONLY in-scope tasks; the secret never appears', () => {
  const r = rpc(agent-b.token, 'get_ready');
  assert.equal(r.status, 200);
  const ids = [
    ...r.body.up_next.map((x) => x.id),
    ...r.body.in_progress.map((x) => x.id),
    ...r.body.open_questions.map((x) => x.id),
  ];
  assert.ok(ids.includes(MINE), 'in-scope up_next present');
  assert.ok(ids.includes(DOING), 'in-scope doing present');
  assert.ok(ids.includes(Q), 'in-scope question present');
  assert.ok(!ids.includes(SECRET), 'secret excluded');
  assert.ok(!ids.includes(SAMEASG_OTHERPROJ), 'assignee-match/project-miss excluded');
  assert.ok(!ids.includes(OTHERASG_MYPROJ), 'project-match/assignee-miss excluded');
  assert.ok(!JSON.stringify(r.body).includes('secret security finding'), 'secret title absent from payload');
});
t('get_ready (unscoped token): sees the whole tracker (sanity)', () => {
  const r = rpc(full.token, 'get_ready');
  assert.ok(r.body.up_next.some((x) => x.id === SECRET));
});
t('args can NARROW but never WIDEN the scope (probes return empty, not errors)', () => {
  for (const probe of [{ assignee: 'agent-a' }, { project: 'secops' }]) {
    const r = rpc(agent-b.token, 'get_ready', probe);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { up_next: [], in_progress: [], open_questions: [] });
  }
});
t('up_next (scoped): skips the higher-priority out-of-scope task', () => {
  const r = rpc(agent-b.token, 'up_next');
  assert.equal(r.body.task?.id, MINE, 'returns MINE, not the P0 secret');
});
t('each scope axis confines independently (project-only and assignee-only tokens)', () => {
  assert.equal(rpc(projOnly.token, 'get', { id: OTHERASG_MYPROJ }).status, 200);
  assert.equal(rpc(projOnly.token, 'get', { id: SECRET }).status, 404);
  assert.equal(rpc(asgOnly.token, 'get', { id: SAMEASG_OTHERPROJ }).status, 200);
  assert.equal(rpc(asgOnly.token, 'get', { id: OTHERASG_MYPROJ }).status, 404);
});

// ── 5. get/update/close by id: out-of-scope is a generic 404 ─────────────────
t('get: out-of-scope id and nonexistent id are INDISTINGUISHABLE 404s', () => {
  const a = rpc(agent-b.token, 'get', { id: SECRET });
  const b = rpc(agent-b.token, 'get', { id: 99999999 });
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(a.body, { error: 'not_found' });
});
t('get: in-scope id → 200 with the shaped task', () => {
  const r = rpc(agent-b.token, 'get', { id: MINE });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.project, 'scoutlab');
  assert.equal(r.body.task.assignee, 'agent-b');
  assert.equal(rpc(agent-b.token, 'get', { id: 'MINE' }).status, 400); // non-integer id
});
t('update: out-of-scope → 404 and the row is untouched', () => {
  const before = getTask(SECRET).title;
  const r = rpc(agent-b.token, 'update', { id: SECRET, title: 'pwned' });
  assert.equal(r.status, 404);
  assert.equal(getTask(SECRET).title, before);
});
t('update: in-scope → 200 via canonical updateTask (audit event logged)', () => {
  const r = rpc(agent-b.token, 'update', { id: MINE, title: 'agent-b task one (renamed)', priority: 1 });
  assert.equal(r.status, 200);
  assert.equal(getTask(MINE).title, 'agent-b task one (renamed)');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='update'").get(MINE), "canonical 'update' event exists");
});
t('update: cannot move a task out of scope or touch server-only columns', () => {
  assert.equal(rpc(agent-b.token, 'update', { id: MINE, assignee: 'agent-a' }).status, 400);
  assert.equal(rpc(agent-b.token, 'update', { id: MINE, project: 'secops' }).status, 400);
  assert.equal(rpc(agent-b.token, 'update', { id: MINE, owner: 'agent-b' }).status, 400);       // not in allowlist
  assert.equal(rpc(agent-b.token, 'update', { id: MINE, visibility: 'shared' }).status, 400); // not in allowlist
  assert.equal(rpc(agent-b.token, 'update', { id: MINE, claim_token: 'x' }).status, 400);     // not in allowlist
  assert.equal(rpc(agent-b.token, 'update', { id: MINE, status: 'nonsense' }).status, 400);
  assert.equal(getTask(MINE).assignee, 'agent-b');
  assert.equal(getTask(MINE).project_id, scoutlab);
});
t('close: out-of-scope → 404; missing reason → 422 rejected (why-ledger enforced)', () => {
  assert.equal(rpc(agent-b.token, 'close', { id: SECRET, reason: 'x' }).status, 404);
  const r = rpc(agent-b.token, 'close', { id: MINE });
  assert.equal(r.status, 422);
  assert.equal(r.body.rejected.reason, 'reason_required');
  assert.notEqual(getTask(MINE).status, 'done');
});
t('update: terminal/doing statuses are refused — must route through close/claim', () => {
  const c = mk('status-guard task', { project_id: scoutlab, assignee: 'agent-b' });
  for (const status of ['done', 'dropped', 'doing']) {
    assert.equal(rpc(agent-b.token, 'update', { id: c, status }).status, 400, `update status=${status} rejected`);
  }
  assert.equal(getTask(c).status, 'todo', 'task status unchanged by the rejected updates');
  assert.equal(rpc(agent-b.token, 'update', { id: c, status: 'review' }).status, 200); // safe transition still works
  assert.equal(getTask(c).status, 'review');
});
t('shape: parent_id is withheld when the parent is out of scope, kept when in scope', () => {
  const oosChild = createTask({ title: 'child of secret', kind: 'task', project_id: scoutlab, parent_id: SECRET });
  updateTask(oosChild, { assignee: 'agent-b' });
  const inChild = createTask({ title: 'child of MINE', kind: 'task', project_id: scoutlab, parent_id: MINE });
  updateTask(inChild, { assignee: 'agent-b' });
  const a = rpc(agent-b.token, 'get', { id: oosChild });
  assert.equal(a.status, 200);
  assert.equal(a.body.task.parent_id, undefined, 'out-of-scope parent id is NOT leaked (no existence oracle)');
  const b = rpc(agent-b.token, 'get', { id: inChild });
  assert.equal(b.body.task.parent_id, MINE, 'in-scope parent id is preserved');
});

// ── 6. claim: confined to scope by construction ──────────────────────────────
t('claim: grabs the in-scope task, never the better-ranked P0 secret; worker is pinned', () => {
  const r = rpc(agent-b.token, 'claim', { worker: 'agent-a' }); // forged worker must be ignored
  assert.equal(r.status, 200);
  assert.equal(r.body.claimed?.id, MINE);
  assert.ok(r.body.token, 'claim token returned');
  const row = getTask(MINE);
  assert.equal(row.status, 'doing');
  assert.equal(row.claimed_by, 'agent-b', 'claimed_by is the token identity, not the forged worker arg');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='claim'").get(MINE), "canonical 'claim' event exists");
  assert.equal(getTask(SECRET).status, 'todo', 'secret untouched');
});
t('claim: with only out-of-scope work available → {claimed:null}', () => {
  // MINE is now doing; the remaining up_next=1 todos (SECRET, SAMEASG_OTHERPROJ,
  // OTHERASG_MYPROJ) are all out of agent-b's scope.
  const r = rpc(agent-b.token, 'claim', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.claimed, null);
  assert.equal(getTask(SECRET).status, 'todo');
  assert.equal(getTask(SAMEASG_OTHERPROJ).status, 'todo');
  assert.equal(getTask(OTHERASG_MYPROJ).status, 'todo');
});
t('claim: an out-of-scope project arg yields null, not out-of-scope work', () => {
  const r = rpc(agent-b.token, 'claim', { project: 'secops' });
  assert.equal(r.body.claimed, null);
});

// ── 7. writes ride the canonical helpers: invariants hold ────────────────────
t('blocked-guard: rpc update to blocked with no live blocker → 422 rejected', () => {
  const c = mk('no blockers here', { project_id: scoutlab, assignee: 'agent-b' });
  const r = rpc(agent-b.token, 'update', { id: c, status: 'blocked' });
  assert.equal(r.status, 422);
  assert.equal(r.body.rejected.reason, 'no_blockers');
});
t('cascade-unblock + why-ledger: rpc close frees the dependent and logs it', () => {
  const a = mk('blocker task', { project_id: scoutlab, assignee: 'agent-b' });
  const b = mk('dependent task', { project_id: scoutlab, assignee: 'agent-b' });
  addBlocker(b, a);
  updateTask(b, { status: 'blocked' });
  assert.equal(getTask(b).status, 'blocked');
  const r = rpc(agent-b.token, 'close', { id: a, reason: 'shipped via rpc', result_summary: 'done cleanly' });
  assert.equal(r.status, 200);
  assert.equal(getTask(a).status, 'done');
  assert.equal(getTask(a).close_reason, 'shipped via rpc');
  assert.equal(getTask(a).result_summary, 'done cleanly');
  assert.equal(getTask(b).status, 'todo', 'dependent auto-unblocked (cascade preserved)');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='closed'").get(a), "canonical 'closed' event exists");
});

// ── 8. file: the new task is FORCED into scope ────────────────────────────────
t('file: out-of-scope project → 400; project omitted under a project scope → 400', () => {
  assert.equal(rpc(agent-b.token, 'file', { title: 'sneak', project: 'secops' }).status, 400);
  assert.equal(rpc(agent-b.token, 'file', { title: 'floating' }).status, 400);
});
t('file: lands in scope with assignee FORCED to the token scope', () => {
  const r = rpc(agent-b.token, 'file', { title: 'scouted idea', project: 'scoutlab', assignee: 'agent-a', kind: 'idea' });
  assert.equal(r.status, 201);
  assert.equal(r.body.filed.project, 'scoutlab');
  assert.equal(r.body.filed.assignee, 'agent-b', 'assignee overridden to the scope, not the caller value');
  assert.equal(r.body.filed.status, 'inbox');
  const k = rpc(agent-b.token, 'file', { title: 'scouted task', project: 'scoutlab', kind: 'task' });
  assert.equal(k.body.filed.status, 'todo');
});
t('file: parent/discovered_from cannot reference out-of-scope tasks (no existence oracle)', () => {
  const oos = rpc(agent-b.token, 'file', { title: 'sub', project: 'scoutlab', parent_id: SECRET });
  const missing = rpc(agent-b.token, 'file', { title: 'sub', project: 'scoutlab', parent_id: 99999999 });
  assert.equal(oos.status, 400);
  assert.equal(missing.status, 400);
  assert.deepEqual(oos.body, missing.body, 'out-of-scope and nonexistent parents are indistinguishable');
  assert.equal(rpc(agent-b.token, 'file', { title: 'x', project: 'scoutlab', discovered_from: SECRET }).status, 400);
});
t('file: unscoped token without a project falls back to the default project (MCP parity)', () => {
  const r = rpc(full.token, 'file', { title: 'floating idea from unscoped token' });
  assert.equal(r.status, 201);
  assert.equal(r.body.filed.project, 'inbox');
});

// ── 9. reap: only this agent\'s own leases ────────────────────────────────────
t('reap: flips only leases claimed by this agent_name', () => {
  const mkLease = (title, who) => {
    const id = mk(title, { project_id: scoutlab, assignee: who });
    updateTask(id, { status: 'doing', claimed_by: who, claim_token: 'tok-' + who, lease_expires_at: '2020-01-01 00:00:00' });
    return id;
  };
  const mineExpired = mkLease('agent-b stale lease', 'agent-b');
  const theirsExpired = mkLease('agent-a stale lease', 'agent-a');
  const r = rpc(agent-b.token, 'reap', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.reaped, 1);
  assert.equal(getTask(mineExpired).status, 'todo');
  assert.equal(getTask(theirsExpired).status, 'doing', "someone else's lease untouched");
});

// ── 9b. blocker edges + task type ─────────────────────────────────────────────
_resetRateLimiter(); // the sections above spent most of agent-b's bucket
const edgeCount = (task, blocker) => db.prepare('SELECT COUNT(*) n FROM task_blockers WHERE task_id=? AND blocker_id=?').get(task, blocker).n;
t('add_blocker: in-scope edge → 200 via canonical addBlocker; todo task flips to blocked; idempotent', () => {
  const a = mk('edge blocker', { project_id: scoutlab, assignee: 'agent-b' });
  const b = mk('edge dependent', { project_id: scoutlab, assignee: 'agent-b' });
  const r = rpc(agent-b.token, 'add_blocker', { id: b, blocked_by: a });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, true);
  assert.equal(edgeCount(b, a), 1);
  assert.equal(getTask(b).status, 'blocked', 'todo + live blocker → blocked (claim skips it)');
  assert.equal(r.body.task.status, 'blocked');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='add_blocker'").get(b), "canonical 'add_blocker' event exists");
  const again = rpc(agent-b.token, 'add_blocker', { id: b, blocked_by: a });
  assert.equal(again.status, 200);
  assert.equal(again.body.added, false, 're-adding is a no-op');
  assert.equal(edgeCount(b, a), 1);
  assert.ok(logLines.some((l) => l.includes(`add_blocker task=${b} blocked_by=${a} -> ok`)), 'audit line names both ends');
});
t('add_blocker: a doing task keeps its lease (status untouched); a done blocker does not block', () => {
  const a = mk('live blocker', { project_id: scoutlab, assignee: 'agent-b' });
  const d = mk('leased dependent', { project_id: scoutlab, assignee: 'agent-b', status: 'doing' });
  assert.equal(rpc(agent-b.token, 'add_blocker', { id: d, blocked_by: a }).status, 200);
  assert.equal(getTask(d).status, 'doing');
  const fin = mk('finished blocker', { project_id: scoutlab, assignee: 'agent-b', status: 'done' });
  const c = mk('dependent of finished', { project_id: scoutlab, assignee: 'agent-b' });
  assert.equal(rpc(agent-b.token, 'add_blocker', { id: c, blocked_by: fin }).status, 200);
  assert.equal(edgeCount(c, fin), 1, 'edge recorded');
  assert.equal(getTask(c).status, 'todo', 'no live blocker → stays todo');
});
t('add_blocker: an up_next task in review with a live blocker leaves get_ready/up_next', () => {
  const a = mk('review blocker', { project_id: scoutlab, assignee: 'agent-b' });
  const r = mk('review dependent', { project_id: scoutlab, assignee: 'agent-b', status: 'review', up_next: 1, rank: -1000 });
  const ready = () => rpc(agent-b.token, 'get_ready', {}).body.up_next.map((x) => x.id);
  assert.ok(ready().includes(r), 'precondition: listed before the edge');
  assert.equal(rpc(agent-b.token, 'add_blocker', { id: r, blocked_by: a }).status, 200);
  assert.equal(getTask(r).status, 'review', 'status untouched');
  assert.ok(!ready().includes(r), 'live blocker hides it from get_ready');
  assert.notEqual(rpc(agent-b.token, 'up_next', {}).body.task?.id, r, 'and from up_next');
  closeTask(a, { status: 'done', reason: 'test' });
  assert.ok(ready().includes(r), 'finished blocker → ready again');
});
t('add_blocker: self-block and cycles are refused, nothing written', () => {
  const x = mk('cyc x', { project_id: scoutlab, assignee: 'agent-b' });
  const y = mk('cyc y', { project_id: scoutlab, assignee: 'agent-b' });
  const z = mk('cyc z', { project_id: scoutlab, assignee: 'agent-b' });
  assert.deepEqual(rpc(agent-b.token, 'add_blocker', { id: x, blocked_by: x }).body, { error: 'self_block' });
  assert.equal(rpc(agent-b.token, 'add_blocker', { id: y, blocked_by: x }).status, 200); // y blocked by x
  assert.equal(rpc(agent-b.token, 'add_blocker', { id: z, blocked_by: y }).status, 200); // z blocked by y
  const r = rpc(agent-b.token, 'add_blocker', { id: x, blocked_by: z });                 // x by z → x→y→z→x
  assert.equal(r.status, 422);
  assert.equal(r.body.rejected.reason, 'would_cycle');
  assert.equal(edgeCount(x, z), 0);
  assert.equal(getTask(x).status, 'todo');
});
t('add/remove_blocker: out-of-scope task → 404; out-of-scope and missing blocker are indistinguishable', () => {
  const mine = mk('scoped end', { project_id: scoutlab, assignee: 'agent-b' });
  assert.deepEqual(rpc(agent-b.token, 'add_blocker', { id: SECRET, blocked_by: mine }).body, { error: 'not_found' });
  const oos = rpc(agent-b.token, 'add_blocker', { id: mine, blocked_by: SECRET });
  const missing = rpc(agent-b.token, 'add_blocker', { id: mine, blocked_by: 99999999 });
  assert.equal(oos.status, 400);
  assert.deepEqual(oos.body, missing.body);
  assert.deepEqual(oos.body, { error: 'invalid_blocker' });
  assert.equal(edgeCount(mine, SECRET), 0);
  assert.equal(rpc(agent-b.token, 'remove_blocker', { id: SECRET, blocked_by: mine }).status, 404);
  assert.equal(rpc(agent-b.token, 'add_blocker', { id: mine, blocked_by: 'x' }).status, 400);
  assert.equal(rpc(agent-b.token, 'add_blocker', { id: mine }).status, 400);
});
t('remove_blocker: drops the edge, auto-unblocks, logs; missing edge → removed:false with no event', () => {
  const a = mk('rm blocker', { project_id: scoutlab, assignee: 'agent-b' });
  const b = mk('rm dependent', { project_id: scoutlab, assignee: 'agent-b' });
  rpc(agent-b.token, 'add_blocker', { id: b, blocked_by: a });
  assert.equal(getTask(b).status, 'blocked');
  const r = rpc(agent-b.token, 'remove_blocker', { id: b, blocked_by: a });
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, true);
  assert.equal(edgeCount(b, a), 0);
  assert.equal(getTask(b).status, 'todo', 'no live blockers left → auto-unblocked');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='remove_blocker'").get(b));
  const n = db.prepare("SELECT COUNT(*) n FROM events WHERE task_id=? AND type='remove_blocker'").get(b).n;
  const again = rpc(agent-b.token, 'remove_blocker', { id: b, blocked_by: a });
  assert.equal(again.body.removed, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE task_id=? AND type='remove_blocker'").get(b).n, n);
});
t('list_blockers: both directions; out-of-scope neighbours are dropped', () => {
  const a = mk('lb up', { project_id: scoutlab, assignee: 'agent-b' });
  const b = mk('lb mid', { project_id: scoutlab, assignee: 'agent-b' });
  const c = mk('lb down', { project_id: scoutlab, assignee: 'agent-b' });
  rpc(agent-b.token, 'add_blocker', { id: b, blocked_by: a });
  rpc(agent-b.token, 'add_blocker', { id: c, blocked_by: b });
  addBlocker(b, SECRET); // an edge only an unscoped caller could make
  const r = rpc(agent-b.token, 'list_blockers', { id: b });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.blocked_by.map((x) => x.id), [a], 'secret blocker hidden');
  assert.deepEqual(r.body.blocks.map((x) => x.id), [c]);
  assert.deepEqual(Object.keys(r.body.blocked_by[0]).sort(), ['id', 'status', 'title']);
  assert.ok(!JSON.stringify(r.body).includes('secret security finding'));
  const u = rpc(full.token, 'list_blockers', { id: b });
  assert.deepEqual(u.body.blocked_by.map((x) => x.id).sort((p, q) => p - q), [SECRET, a].sort((p, q) => p - q), 'unscoped sees it');
  assert.equal(rpc(agent-b.token, 'list_blockers', { id: SECRET }).status, 404);
});
t('set_type: allowlisted type via canonical updateTask; bad type / out-of-scope refused', () => {
  const m = mk('a map', { project_id: scoutlab, assignee: 'agent-b' });
  const r = rpc(agent-b.token, 'set_type', { id: m, type: 'wayfinder-map' });
  assert.equal(r.status, 200);
  assert.equal(r.body.updated.type, 'wayfinder-map');
  assert.equal(getTask(m).type, 'wayfinder-map');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='update' AND data LIKE '%wayfinder-map%'").get(m));
  assert.deepEqual(rpc(agent-b.token, 'set_type', { id: m, type: 'wayfinder_map' }).body, { error: 'bad_type' });
  assert.equal(rpc(agent-b.token, 'set_type', { id: m }).status, 400);
  assert.equal(getTask(m).type, 'wayfinder-map', 'rejected calls change nothing');
  const before = getTask(SECRET).type;
  assert.equal(rpc(agent-b.token, 'set_type', { id: SECRET, type: 'research' }).status, 404);
  assert.equal(getTask(SECRET).type, before);
});
t('file: optional type is validated and applied', () => {
  const r = rpc(agent-b.token, 'file', { title: 'typed ticket', project: 'scoutlab', kind: 'task', type: 'research' });
  assert.equal(r.status, 201);
  assert.equal(getTask(r.body.filed.id).type, 'research');
  assert.equal(rpc(agent-b.token, 'file', { title: 'bad', project: 'scoutlab', type: 'nope' }).status, 400);
});

// ── 10. rate limit ────────────────────────────────────────────────────────────
t('rate limit: 61st request inside a minute → 429', () => {
  const ratey = mintAgentToken({ agent_name: 'ratey', scope_assignee: 'ratey', readonly: false });
  _resetRateLimiter();
  let last;
  for (let i = 0; i < 61; i++) last = rpc(ratey.token, 'up_next');
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'rate_limited' });
  _resetRateLimiter();
});

// ── 11. hygiene: audit lines exist, tokens never logged ──────────────────────
t('audit log lines are written and NEVER contain a plaintext token', () => {
  assert.ok(logLines.some((l) => l.startsWith('[agent-api] agent-b ')), 'audit lines present');
  const all = logLines.join('\n');
  for (const tok of [agent-b, full, projOnly, asgOnly]) {
    assert.ok(!all.includes(tok.token), 'plaintext token absent from logs');
  }
});
t('unknown op is NOT echoed into logs — an op set to the token value never leaks it', () => {
  const before = logLines.length;
  const r = rpc(agent-b.token, agent-b.token); // op === the bearer token string
  assert.equal(r.status, 400);
  const added = logLines.slice(before).join('\n');
  assert.ok(!added.includes(agent-b.token), 'the caller-controlled op value (a token) is not written to logs');
  assert.ok(added.includes('unknown-op len='), 'unknown op is logged as a length, not its content');
});

t('mintAgentToken REFUSES to mint without an explicit readonly decision', () => {
  assert.throws(() => mintAgentToken({ agent_name: 'forgot-the-flag' }), /readonly/);
  assert.throws(() => mintAgentToken({ agent_name: 'wrong-type', readonly: 'yes' }), /readonly/);
  // positive control: it is the MISSING decision that is refused, not minting itself
  assert.ok(mintAgentToken({ agent_name: 'said-so-rw', readonly: false }).token);
  assert.ok(mintAgentToken({ agent_name: 'said-so-ro', readonly: true }).token);
});

// ── read-only scope ───────────────────────────────────────────────────────────
// A token that can read must not be able to close, file, update, claim or reap.
const ro = mintAgentToken({ agent_name: 'briefing-ro', scope_assignee: 'agent-b', readonly: true });
const rw = mintAgentToken({ agent_name: 'briefing-rw', scope_assignee: 'agent-b', readonly: false });

t('read-only token is surfaced by verifyAgentToken', () => {
  assert.equal(verifyAgentToken(ro.token).scope_readonly, true);
  assert.equal(verifyAgentToken(rw.token).scope_readonly, false, 'default must stay read-WRITE for back-compat');
});

t('read-only token CAN call get_ready', () => {
  const r = rpc(ro.token, 'get_ready');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.up_next), 'returns the briefing shape');
});

t('read-only token CAN call get', () => {
  // createTask returns the ID itself, not a row object.
  const mine = createTask({ title: 'ro-visible', kind: 'task', project_id: scoutlab });
  updateTask(mine, { assignee: 'agent-b' }); // must be IN the token scope to be gettable
  const r = rpc(ro.token, 'get', { id: mine });
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.task.id, mine);
});

for (const [op, args] of [
  ['update', { id: 1, status: 'doing' }],
  ['close', { id: 1 }],
  ['file', { title: 'should never exist' }],
  ['claim', {}],
  ['reap', {}],
]) {
  t(`read-only token is REFUSED ${op} with 403 read_only_token`, () => {
    const r = rpc(ro.token, op, args);
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    assert.equal(r.body.error, 'read_only_token');
  });

  // positive control: the gate must not be refusing everyone. Without this, deleting
  // READ_OPS entirely (refuse all ops) would leave every assertion above still green.
  t(`a NON-read-only token is still allowed ${op}`, () => {
    const r = rpc(rw.token, op, args);
    assert.notEqual(r.status, 403, `${op} must not be 403 for a read-write token`);
  });
}

t('a write refused by the read-only gate has no side effect', () => {
  const before = db.prepare("SELECT COUNT(*) c FROM tasks WHERE title='should never exist'").get().c;
  rpc(ro.token, 'file', { title: 'should never exist' });
  const after = db.prepare("SELECT COUNT(*) c FROM tasks WHERE title='should never exist'").get().c;
  assert.equal(after, before, 'refused write must not reach the handler');
});

t('the read-only refusal is logged without the token', () => {
  const before = logLines.length;
  rpc(ro.token, 'close', { id: 1 });
  const added = logLines.slice(before).join('\n');
  assert.ok(added.includes('read_only_token'), 'refusal is audited');
  assert.ok(!added.includes(ro.token), 'token never appears in a log line');
});

// ── report ────────────────────────────────────────────────────────────────────
let failed = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ` — ${c.detail}`}`);
  if (!c.pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
try { db.close(); rmSync(TMP, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
