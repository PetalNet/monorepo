#!/usr/bin/env node
// Seed a SCRATCH database for headless a11y verification (never the live DB).
// Usage: TASKS_DB_PATH=/tmp/a11y-scratch/tasks.db node scripts/dev-seed-a11y.mjs
if (!process.env.TASKS_DB_PATH || process.env.TASKS_DB_PATH.includes('/srv/tasks/data')) {
  console.error('refusing: set TASKS_DB_PATH to a scratch path');
  process.exit(1);
}
await import('../src/lib/server/db.js'); // creates schema at TASKS_DB_PATH
const { default: Database } = await import('better-sqlite3');
const db = new Database(process.env.TASKS_DB_PATH);
db.prepare(`INSERT INTO projects (name) VALUES ('petal')`).run();
const pid = db.prepare(`SELECT id FROM projects WHERE name='petal'`).get().id;
const ins = db.prepare(`INSERT INTO tasks (title, kind, status, priority, body, body_alt, options) VALUES (?,?,?,?,?,?,?)`);
db.prepare(`INSERT INTO tasks (title, kind, status, priority, project_id, assignee) VALUES ('Filter fixture','task','todo',2,?, 'agent-a')`).run(pid);
const q = ins.run('Pick the deployment color', 'question', 'todo', 2, 'Which rollout color should we use?', '', JSON.stringify([{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }, { value: 'green', label: 'Green' }]));
const doc = ins.run('Reader controls fixture', 'task', 'todo', 2, '# Fixture\n\nA body long enough to narrate.\n\n- one\n- two', 'Plain english version of the fixture body.', '');
const inbox = ins.run('Inbox triage fixture', 'idea', 'inbox', 3, '', '', '');
console.log(JSON.stringify({ question: q.lastInsertRowid, doc: doc.lastInsertRowid, inbox: inbox.lastInsertRowid }));
