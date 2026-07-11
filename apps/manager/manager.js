#!/usr/bin/env node
/**
 * Janet Terminal Manager
 * Manages a persistent Claude Code session with auto-resume on rate limits.
 * Reports status / accepts commands via @janet:mx.petalcat.dev in Matrix.
 *
 * Usage: node manager.js [work-dir]
 * Commands (from Matrix): start | stop | restart | status
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import https from 'https';
import http from 'http';
import path from 'path';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const CREDS_PATH     = path.join(os.homedir(), '.claude/shared/janet-account.json');
const STATE_PATH     = path.join(os.homedir(), '.claude/shared/janet-session-state.json');
const RATE_HOOK_FILE = path.join(os.homedir(), '.claude/shared/janet-rate-limit.json');
const MODEL_PATH     = path.join(os.homedir(), '.claude/shared/janet-model');  // task-439: optional model override for the resumed session

const CREDS = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
const HOMESERVER  = CREDS.homeserver;
const JANET_TOKEN = CREDS.access_token;
const JANET_UID   = CREDS.user_id;
const CONTROL_ROOM = '!FccCIgRbxzylIkvkNk:mx.petalcat.dev'; // PM with Parker

const WORK_DIR = process.argv[2] || os.homedir();

// Persist session ID across restarts so --continue always resumes the right thread
function loadOrCreateSessionId() {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')).sessionId; } catch {}
  }
  const id = randomUUID();
  writeFileSync(STATE_PATH, JSON.stringify({ sessionId: id }), { mode: 0o600 });
  return id;
}
const SESSION_ID = loadOrCreateSessionId();

// ── State ─────────────────────────────────────────────────────────────────────

const STATES = { STARTING:'starting', RUNNING:'running', RATE_LIMITED:'rate_limited',
                 WAITING:'waiting', RESUMING:'resuming', CRASHED:'crashed', STOPPED:'stopped' };

let state         = STATES.STOPPED;
let claudeProc    = null;
let crashCount    = 0;
let crashBackoff  = 5_000;          // ms, doubles on each crash, caps at 30 min
let processStartTime = null;        // when current Claude session was last spawned; used to distinguish fast-fails from long-running exits
const QUICK_CRASH_MS = 60_000;      // if Claude exits within this window of starting, treat as a fast-fail and bump crashCount
let lastOutputAt  = Date.now();
let rateLimitReset = null;           // Date when rate limit resets
let resumeTimer   = null;
let syncToken     = null;
let shutdownFlag  = false;

// ── Rate-limit parsing ────────────────────────────────────────────────────────

const RATE_LIMIT_RE = /usage.?limit|limit reached|resets? at/i;
const RESET_TIME_RE = /resets? at (\d{1,2}):(\d{2})\s*([AP]M)?/i;

function parseResetDate(line) {
  const m = line.match(RESET_TIME_RE);
  if (!m) return null;

  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const ampm = (m[3] || '').toUpperCase();

  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;

  const d = new Date();
  d.setHours(h, min, 10, 0); // 10s grace inside the minute
  if (d <= new Date()) d.setDate(d.getDate() + 1);

  // Sanity cap: never wait more than 24 hours (Claude's windows max out well under this)
  const cap = new Date(Date.now() + 24 * 3_600_000);
  return d < cap ? d : cap;
}

// ── ANSI strip ────────────────────────────────────────────────────────────────

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[mGKHFJABCDSTsu]/g, '')
          .replace(/\x1b\][^\x07]*\x07/g, '')
          .replace(/\x1b[()][AB0-2]/g, '');
}

// ── Matrix helpers ────────────────────────────────────────────────────────────

function matrixRequest(method, path, body, token) {
  return new Promise((resolve) => {
    const url = new URL(HOMESERVER + path);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${token || JANET_TOKEN}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', (e) => { console.error('[janet/matrix] request error:', e.message); resolve({ status: 0, body: {} }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function matrixSend(text) {
  const txnId = Date.now();
  await matrixRequest(
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(CONTROL_ROOM)}/send/m.room.message/${txnId}`,
    { msgtype: 'm.text', body: text }
  );
}

async function matrixSync(timeout = 30_000) {
  const qs = syncToken
    ? `?since=${encodeURIComponent(syncToken)}&timeout=${timeout}&filter=${encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 10 } } }))}`
    : `?timeout=0&filter=${encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 0 } } }))}`;

  const r = await matrixRequest('GET', `/_matrix/client/v3/sync${qs}`);
  if (!r.body.next_batch) return [];

  syncToken = r.body.next_batch;

  const timeline = r.body.rooms?.join?.[CONTROL_ROOM]?.timeline?.events || [];
  return timeline
    .filter(e => e.type === 'm.room.message' && e.sender !== JANET_UID)
    .map(e => (e.content?.body || '').trim())
    .filter(s => s.startsWith('!'))
    .map(s => s.slice(1).toLowerCase().trim());
}

// ── Process management ────────────────────────────────────────────────────────

function setState(s) {
  state = s;
  console.log(`[janet] → ${s}`);
}

function checkRateLimitHookFile() {
  try {
    if (!existsSync(RATE_HOOK_FILE)) return;
    const d = JSON.parse(readFileSync(RATE_HOOK_FILE, 'utf8'));
    unlinkSync(RATE_HOOK_FILE);
    if (d.resetAt) {
      rateLimitReset = new Date(d.resetAt);
      console.log(`[janet] rate limit from hook — reset at ${rateLimitReset.toISOString()}`);
    }
  } catch {}
}

const TMUX_SESSION = 'janet-claude';
// Pane-pinned target for capture-pane/send-keys. Bug fix (2026-07-01): targeting
// just TMUX_SESSION resolves to whichever pane is currently ACTIVE in the window,
// not necessarily pane 0 (the real Claude pane) — e.g. Eli split the window to
// nano-hack (pane 1) and the manager's auto-accept/slash-passthrough keystrokes
// silently landed in nano instead of Claude. Pin to window 0 / pane 0 explicitly.
// (Session-scoped ops — has-session/kill-session/new-session — don't need this.)
const TMUX_PANE = `${TMUX_SESSION}:0.0`;
// Slash-command passthrough gate (see commandLoop). Safe, non-mutating commands
// only. NEVER add /model, /config, /fast — they hang my own session.
const SLASH_ALLOW = new Set(['/compact', '/context', '/cost', '/status']);
const SLASH_DENY_RE = /^\/(model|config|fast|login|logout|theme|init|mcp)\b/;
const EXIT_CODE_FILE = path.join(os.homedir(), '.claude/shared/janet-exit-code');

function tmux(...args) {
  return new Promise((resolve) => {
    const p = spawn('tmux', args, { stdio: 'pipe' });
    let out = '';
    p.stdout?.on('data', d => out += d);
    p.on('exit', code => resolve({ code, out: out.trim() }));
  });
}

async function tmuxAlive() {
  const r = await tmux('has-session', '-t', TMUX_SESSION);
  return r.code === 0;
}

// Watcher attached after a spawn OR an adopt — fires handleExit when the
// tmux session goes away. Extracted so spawn-path and adopt-path share it.
function attachTmuxExitPoll() {
  const poll = setInterval(async () => {
    if (shutdownFlag) { clearInterval(poll); return; }
    if (!(await tmuxAlive())) {
      clearInterval(poll);
      claudeProc = null;
      let code = 1;
      try { code = parseInt(readFileSync(EXIT_CODE_FILE, 'utf8').trim()) || 0; } catch {}
      console.log(`[janet] tmux session ended, exit code=${code}`);
      checkRateLimitHookFile();
      if (!shutdownFlag) handleExit(code, null);
    }
  }, 5_000);
}

async function startClaude(resume = false) {
  if (await tmuxAlive()) {
    if (!claudeProc) {
      // Adopt an existing tmux session — manager just rebooted while Claude was
      // still running. Skip the spawn but take ownership so commands and crash
      // recovery work. Same poll attaches.
      console.log('[janet] adopting existing tmux session');
      processStartTime = Date.now();
      lastOutputAt = Date.now();
      setState(STATES.RUNNING);
      claudeProc = true;
      attachTmuxExitPoll();
    }
    return;
  }

  setState(STATES.STARTING);

  // Clean up stale exit code file
  try { unlinkSync(EXIT_CODE_FILE); } catch {}

  // Remove any stale Claude session lock for our session ID so reuse doesn't fail with "already in use"
  try {
    const sessDir = path.join(os.homedir(), '.claude', 'sessions');
    for (const f of readdirSync(sessDir)) {
      try {
        const lock = JSON.parse(readFileSync(path.join(sessDir, f), 'utf8'));
        if (lock.sessionId === SESSION_ID) unlinkSync(path.join(sessDir, f));
      } catch {}
    }
  } catch {}

  const claudeArgs = [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels', 'server:claude-matrix-channel',
    '--remote-control',
    '--name', 'Janet',
  ];
  // Launch-level model control (task-439): if ~/.claude/shared/janet-model holds a model id,
  // pin the resumed session to it via --model. This is the ONLY safe way to switch Janet's
  // model — /model hangs a headless session, and a settings.json model change is IGNORED on
  // --resume (the resume pins the conversation's model). Empty/missing file => default model;
  // clear the file to revert. (See memory: janet-model-swap-footgun.)
  let modelOverride = '';
  try { modelOverride = readFileSync(MODEL_PATH, 'utf8').trim(); } catch {}
  if (modelOverride) { claudeArgs.push('--model', modelOverride); console.log(`[janet] model override -> ${modelOverride}`); }
  if (resume) {
    claudeArgs.push('--resume', SESSION_ID);
  } else {
    claudeArgs.push('--resume', SESSION_ID);
  }

  // Shell command runs inside tmux — writes exit code so we can detect rate limit vs crash
  const cmd = `cd ${WORK_DIR} && PATH="$HOME/.local/bin:$PATH" claude ${claudeArgs.join(' ')}; echo $? > ${EXIT_CODE_FILE}`;

  console.log(`[janet] tmux: ${cmd}`);
  await tmux('kill-session', '-t', TMUX_SESSION);  // clean up any zombie
  await tmux('new-session', '-d', '-s', TMUX_SESSION, '-x', '220', '-y', '50', cmd);

  processStartTime = Date.now();
  lastOutputAt = Date.now();
  setState(STATES.RUNNING);

  // Auto-accept Claude's startup prompts
  (async () => {
    let trustDone = false, bypassDone = false, channelDone = false, summaryDone = false;
    for (let i = 0; i < 30 && !(trustDone && bypassDone && channelDone && summaryDone); i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (!(await tmuxAlive())) break;
      const { out } = await tmux('capture-pane', '-t', TMUX_PANE, '-p');
      if (!trustDone && out.includes('project you created')) {
        await tmux('send-keys', '-t', TMUX_PANE, '', 'Enter');
        trustDone = true;
      }
      // The resume-from-summary prompt appears when a long-context session is
      // resumed via --resume. We want "summary" (first option, default
      // highlighted) — Enter accepts the default. Phrase match is broad so we
      // catch wording variants across Claude versions.
      if (!summaryDone && (out.includes('resume from summary') || out.includes('Resume from summary') || out.includes('summary or full'))) {
        await tmux('send-keys', '-t', TMUX_PANE, '', 'Enter');
        summaryDone = true;
      }
      if (!bypassDone && out.includes('Bypass Permissions mode')) {
        await tmux('send-keys', '-t', TMUX_PANE, 'Down', '');
        await new Promise(r => setTimeout(r, 200));
        await tmux('send-keys', '-t', TMUX_PANE, '', 'Enter');
        bypassDone = true;
      }
      if (!channelDone && out.includes('Loading development channels')) {
        await tmux('send-keys', '-t', TMUX_PANE, '', 'Enter');
        channelDone = true;
      }
    }
  })();

  // Poll until the tmux session ends
  claudeProc = true; // sentinel so state checks work
  attachTmuxExitPoll();
}

async function handleExit(code, signal) {
  // Intentional stops
  if (signal === 'SIGTERM' || signal === 'SIGINT' || state === STATES.STOPPED) {
    setState(STATES.STOPPED);
    return;
  }

  // Rate limit
  if (rateLimitReset) {
    setState(STATES.RATE_LIMITED);
    const waitMs = Math.max(60_000, rateLimitReset.getTime() - Date.now());
    const waitMin = Math.round(waitMs / 60_000);
    console.log(`[janet] rate limit — waiting ${waitMin}m`);
    await matrixSend(`rate limited — resuming at ${rateLimitReset.toLocaleTimeString()} (${waitMin} min)`);

    crashCount = 0;
    crashBackoff = 5_000;
    const savedReset = rateLimitReset;
    rateLimitReset = null;

    setState(STATES.WAITING);
    resumeTimer = setTimeout(async () => {
      await matrixSend('rate limit cleared — resuming session');
      await startClaude(true);
    }, waitMs + 15_000); // 15s grace after nominal reset
    return;
  }

  // Crash. Only count it against the backoff if the session was short-lived —
  // long-running exits (triggered restarts, manual !restart, etc.) are
  // operationally normal and shouldn't push us toward the cap.
  const uptime = processStartTime ? Date.now() - processStartTime : 0;
  if (uptime > QUICK_CRASH_MS) {
    crashCount = 0;
    crashBackoff = 5_000;
  }
  crashCount++;
  if (crashCount > 10) {
    setState(STATES.STOPPED);
    await matrixSend(`stopped after ${crashCount} crashes — send 'start' to retry`);
    return;
  }

  const delay = Math.min(crashBackoff, 30 * 60_000);
  crashBackoff = Math.min(crashBackoff * 2, 30 * 60_000);

  const delaySec = Math.round(delay / 1000);
  console.log(`[janet] crash #${crashCount} — retry in ${delaySec}s`);
  await matrixSend(`session crashed (${crashCount}/10) — retrying in ${delaySec}s`);

  setState(STATES.CRASHED);
  resumeTimer = setTimeout(() => startClaude(crashCount > 1), delay);
}

// ── Command loop ──────────────────────────────────────────────────────────────

async function commandLoop() {
  // Drain existing messages on startup (don't re-execute stale commands)
  await matrixSync(0);

  while (!shutdownFlag) {
    let commands;
    try {
      commands = await matrixSync(30_000);
    } catch (e) {
      console.error('[janet] sync error:', e.message);
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }

    for (const cmd of commands) {
      console.log(`[janet] command: "${cmd}"`);

      if (cmd === 'start' || cmd === 'go') {
        if (!claudeProc) {
          clearTimeout(resumeTimer);
          await startClaude(crashCount > 0);
        } else {
          await matrixSend(`already ${state}`);
        }

      } else if (cmd === 'stop' || cmd === 'quit') {
        clearTimeout(resumeTimer);
        setState(STATES.STOPPED);
        if (claudeProc) tmux('kill-session', '-t', TMUX_SESSION);
        else await matrixSend('stopped');

      } else if (cmd === 'restart') {
        clearTimeout(resumeTimer);
        if (claudeProc) {
          await matrixSend('restarting...');
          tmux('kill-session', '-t', TMUX_SESSION);
          // handleExit will restart with resume=true after process exits
          crashCount = 0;
          crashBackoff = 5_000;
        } else {
          await startClaude(true);
        }

      } else if (cmd === 'status' || cmd === 'ping' || cmd === '?') {
        const idleS = Math.round((Date.now() - lastOutputAt) / 1000);
        const resetStr = rateLimitReset ? ` reset@${rateLimitReset.toLocaleTimeString()}` : '';
        await matrixSend(
          `state: ${state}${resetStr}\n` +
          `session: ${SESSION_ID.slice(0,8)}...\n` +
          `last output: ${idleS}s ago\n` +
          `crashes: ${crashCount} | cwd: ${WORK_DIR}`
        );

      } else if (cmd.startsWith('/')) {
        // Out-of-band slash-command passthrough (Eli 2026-06-22). Inject a Claude
        // Code slash command into the live TUI from Matrix. The MANAGER does the
        // send-keys, not the model loop — so it still works if the model is wedged.
        // HARD denylist: never /model or settings mutators — swapping my own model
        // hangs the session (memory: janet-model-swap-footgun). Allowlist only.
        const slash = cmd.split(/\s+/)[0];
        if (SLASH_DENY_RE.test(slash) || !SLASH_ALLOW.has(slash)) {
          await matrixSend(`refused "${slash}" — slash allowlist is: ${[...SLASH_ALLOW].join(' ')}`);
        } else if (!claudeProc) {
          await matrixSend(`no live session — can't send ${slash} (start one first)`);
        } else {
          await tmux('send-keys', '-t', TMUX_PANE, cmd, 'Enter');
          await matrixSend(`sent ${cmd} to the live session`);
        }

      } else if (cmd === 'kill session') {
        // Nuclear: forget the session ID so next start is truly fresh
        writeFileSync(STATE_PATH, JSON.stringify({ sessionId: randomUUID() }), { mode: 0o600 });
        if (claudeProc) tmux('kill-session', '-t', TMUX_SESSION);
        await matrixSend('session ID reset — next start will be a fresh conversation');
      }
    }
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(reason) {
  shutdownFlag = true;
  clearTimeout(resumeTimer);
  console.log(`\n[janet] shutting down (${reason})`);
  setState(STATES.STOPPED);
  if (claudeProc) {
    tmux('kill-session', '-t', TMUX_SESSION);
    
    if (claudeProc) tmux('kill-session', '-t', TMUX_SESSION);
  }
  await matrixSend(`janet manager stopped (${reason})`);
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Boot ──────────────────────────────────────────────────────────────────────

console.log(`[janet] terminal manager starting`);
console.log(`[janet] session: ${SESSION_ID}`);
console.log(`[janet] work dir: ${WORK_DIR}`);
console.log(`[janet] control room: ${CONTROL_ROOM}`);
console.log(`[janet] commands: start | stop | restart | status | kill session | /compact /context /cost /status`);

await matrixSend(`janet online — session ${SESSION_ID.slice(0,8)}...\n!start !stop !restart !status !kill`);
commandLoop(); // runs forever in background
await startClaude(false);
