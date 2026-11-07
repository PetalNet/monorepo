#!/usr/bin/env node
// Static a11y regression guard for the accessibility-hardening batch
// (task-331/332/333/334/335/359/360/361/368). Run: pnpm test:a11y
//
// These are source-level invariants — cheap, dependency-free, and they fail loudly
// if a refactor silently drops the ARIA/semantics/breakpoint fixes. Runtime behavior
// (focus order, live-region announcements) is verified in a headless browser.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failures = 0;
let passes = 0;
function check(name, ok) {
  if (ok) { passes++; console.log(`  ok  ${name}`); }
  else { failures++; console.error(`FAIL  ${name}`); }
}

// ── task-360: shell landmarks, skip link, aria-current ──────────────
const layout = read('src/routes/+layout.svelte');
check('layout: skip link targets #main', layout.includes('class="skip"') && layout.includes('href="#main"'));
check('layout: main has id + programmatic focus target', /<main[^>]*id="main"[^>]*tabindex="-1"/.test(layout));
check('layout: tabbar nav is labeled', /<nav class="tabbar" aria-label=/.test(layout));
check('layout: tabs carry aria-current', (layout.match(/aria-current=\{isActive\(/g) || []).length >= 4);
check('layout: More is a button (not a label/checkbox hack)', /<button class="tab"[^>]*aria-expanded/.test(layout) && !layout.includes('id="more-tgl"'));
check('layout: More sheet is a modal dialog', /role="dialog" aria-modal="true"/.test(layout));
const sidebar = read('src/lib/NavSidebar.svelte');
check('sidebar: nav labeled + aria-current', sidebar.includes('aria-label="Main navigation"') && sidebar.includes("aria-current={on ? 'page' : undefined}"));

// ── task-335: tab labels can never overflow their cell ──────────────
check('layout: tab labels ellipsize', /\.tab span \{[^}]*text-overflow: ellipsis/.test(layout));
const appCss = read('src/app.css');
check('app.css: legacy tab labels ellipsize', /\.tab span \{[^}]*text-overflow:ellipsis/.test(appCss));

// ── focus ring (task-361 follow-through): no forced radius on the ring ──
const focusRule = appCss.match(/:where\(a,button[^{]*\):focus-visible \{[^}]*\}/);
check('app.css: one global focus-visible rule, no border-radius override',
  !!focusRule && !focusRule[0].includes('border-radius') && !layout.includes('border-radius: 3px'));
check('app.css: .vh utility exists', appCss.includes('.vh {'));

// ── task-333: no stray 560px viewport breakpoint on the board ───────
const browse = read('src/routes/browse/+page.svelte');
check('browse: 560px viewport rule is gone', !browse.includes('@media (max-width: 560px)'));
check('browse: phone triage rule uses @container app 760px', /@container app \(max-width: 760px\) \{[^]*?\.tg\.tg-mid \{ display: none/.test(browse));
check('browse: phone triage targets hit 44px', /\.tg \{ min-height: 44px; min-width: 44px/.test(browse));

// ── task-331: filter changes are announced ──────────────────────────
check('browse: polite live region for filter results', browse.includes('role="status" aria-live="polite"') && browse.includes('announcePending'));
check('browse: search match count is a status region', browse.includes('class="sb-count mono" role="status"'));

// ── task-359: answer controls are radiogroups with checked state ────
const detail = read('src/routes/task/[id]/+page.svelte');
check('detail: decision options in fieldset radiogroup', /<fieldset class="answers"[^>]*role="radiogroup"/.test(detail) && detail.includes('<legend class="vh">'));
check('detail: options expose aria-checked', detail.includes('role="radio" aria-checked={t.answer === o.value}'));
check('detail: answered confirmation live region', /role="status" aria-live="polite"[^]*?Answered:/.test(detail));
for (const [name, file] of [['desk', 'src/routes/+page.svelte'], ['browse', 'src/routes/browse/+page.svelte'], ['inbox', 'src/routes/inbox/+page.svelte']]) {
  const src = read(file);
  check(`${name}: one-tap answers are a radiogroup`, src.includes("role=\"radiogroup\"") || src.includes("'radiogroup'"));
  check(`${name}: answers announce on submit`, src.includes('Answer submitted'));
}
check('shared radioNav action exists', read('src/lib/a11y.js').includes('function radioNav'));

// ── task-332: heading structure ──────────────────────────────────────
check('detail: has a real h1 for the task title', detail.includes('<h1 class="vh">'));
const docs = read('src/routes/docs/+page.svelte');
check('docs: lane heads are always h2', !/{#if g\.project_id}<a[^]*{:else}<h2>/.test(docs) && /<h2>\s*\{#if g\.project_id\}<a/.test(docs));

// ── task-334: reader controls reach 44px on phone ────────────────────
check('detail: phone block is @container app 760px', detail.includes('@container app (max-width: 760px)') && !/@media \(max-width: 760px\)/.test(detail));
check('detail: .rb/.seg-btn/.edit-btn min-height 44px on phone', /\.rb, \.seg-btn, \.edit-btn \{ min-height: 44px/.test(detail));

// ── task-361/368: toggle + listen semantics ──────────────────────────
check('detail: version toggle has aria-pressed', detail.includes('aria-pressed={human}') && detail.includes('aria-pressed={!human}'));
check('detail: listen button has aria-pressed', detail.includes('aria-pressed={speaking || loadingAudio}'));
check('detail: TTS status live region', detail.includes('class="tts-status mono"') && detail.includes('aria-live="polite"'));
check('detail: no silent TTS failure paths', detail.includes("ttsStatus = 'Audio unavailable'") && detail.includes('Narration failed, using browser voice'));
check('detail: utterance onerror resets speaking', /u\.onerror = \(\) => \{ speaking = false; ttsStatus/.test(detail));

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
