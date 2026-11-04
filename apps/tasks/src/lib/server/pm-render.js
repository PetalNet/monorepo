// ── ProseMark read-view renderer ───────────────────────────────────────────
// Renders a task body to HTML that lays out LINE-FOR-LINE like the ProseMark /
// CodeMirror editor (src/lib/ProseMark.svelte), so flipping read↔edit doesn't
// shift the text. Ported from the design-system's proven renderer
// (clarity .../design-system/markdown.ts) — pure JS, block-level, NO CodeMirror,
// so there's no headless-virtualization problem the CM-SSR path had.
//
// The key trick (Bob's "blank-line × line-height"): blank source lines are
// COUNTED and turned into vertical space via `margin-top: calc(N * var(--pm-lh))`
// — exactly how CodeMirror renders a blank line as one line-box. Metrics
// (--pm-lh, heading sizes, list geometry) live in the .pm-rendered stylesheet
// and are tuned to the editor's ACTUAL values (14.5px/1.7, h 24/18/15).
//
// Tasks-specific vs the ds source:
//  - single newline = a hard line break (<br>), matching remark-breaks + how CM
//    shows each source line as its own line-box (the ds joined lines with a space).
//  - [[wikilinks]] are resolved (ported from md.js) so the read view keeps them.
//
// XSS: every user-controlled text run goes through esc(); link hrefs are
// allowlisted to http(s):// | / | # (no javascript:); the only generated style
// values are integer blank-counts, never user input. Bodies are untrusted
// (web form / MCP / Corner sync) behind shared SSO, so this is load-bearing —
// do not insert raw user text into an attribute or an unescaped position.

function esc(s) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// ── [[wikilink]] resolution (string form, ported from server/md.js) ──────────
// Same routing + same fixed class names so the read view matches the prior
// rehype-based render. Returns an HTML string; the visible text is esc()'d.
const FLEET_AGENTS = new Set(["agent-a", "claude", "agent-c", "agent-b", "agent-e", "agent-d", "corner"]);
const FLEET_ROUTE_EXISTS = false;

function resolveWikilink(inner) {
	const raw = inner.trim();
	if (!raw) return null;
	const taskMatch = /^(?:task-|#)(\d+)$/i.exec(raw);
	if (taskMatch) {
		const n = taskMatch[1];
		return '<a href="/task/' + n + '" class="wikilink wl-task">task-' + n + "</a>";
	}
	const handle = raw.toLowerCase();
	if (/^[a-z0-9][a-z0-9_-]*$/i.test(raw) && FLEET_AGENTS.has(handle)) {
		if (FLEET_ROUTE_EXISTS) {
			return '<a href="/fleet/' + handle + '" class="wikilink wl-agent">' + esc(raw) + "</a>";
		}
		return '<span class="wikilink wl-agent" title="fleet agent">' + esc(raw) + "</span>";
	}
	return '<span class="wikilink wl-ref">' + esc(raw) + "</span>";
}

// Sentinels are wrapped in \x01 / \x02 control chars: they survive esc() (which
// only touches & < > " '), users don't type them, and they can't collide with
// real markdown. Each protected fragment is restored AFTER esc() runs.
const C0 = "\x01",
	C1 = "\x02";

function inline(raw) {
	const store = [];
	const stash = (html) => {
		store.push(html);
		return C0 + (store.length - 1) + C1;
	};

	// 1) inline code `…` — content esc()'d, restored as <code> verbatim.
	let s = raw.replace(/`([^`]+)`/g, (_, c) => stash("<code>" + esc(c) + "</code>"));
	// 2) [[wikilinks]] — resolved to fixed-class <a>/<span>, text esc()'d inside.
	s = s.replace(/\[\[([^\]\n]+?)\]\]/g, (m, inner) => {
		const html = resolveWikilink(inner);
		return html ? stash(html) : m;
	});
	// 3) escape everything else (user text is now safe; sentinels survive).
	s = esc(s);
	// 4) [text](url) links — url allowlisted (no javascript:); double-quoted href,
	//    and url is already esc()'d so it can't carry a raw quote to break out.
	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, url) =>
		!/^(https?:\/\/|\/|#)/i.test(url) ? t : '<a href="' + url + '" rel="noopener">' + t + "</a>",
	);
	// 5) **bold** then *italic* (italic guard avoids eating ** and mid-word *).
	s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
	// 6) restore protected fragments.
	s = s.replace(new RegExp(C0 + "(\\d+)" + C1, "g"), (_, i) => store[+i]);
	return s;
}

const COPY_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';

export function renderPm(src) {
	if (!src) return "";
	const lines = String(src).split("\n");
	let html = "",
		i = 0,
		blanks = 0,
		firstBlock = true;
	// sep(): the blank-line × line-height gap ABOVE a block. Consecutive blank
	// source lines stack (N × line-height), matching CM's blank line-boxes.
	const sep = () => {
		// gap ABOVE this block = the literal blank-line count (each blank = one CM
		// line-box). NOT Math.max(1,…): CM shows adjacent non-blank lines with zero
		// gap, so two blocks with no blank between them must touch too. First block
		// has no gap (the .pm-rendered top padding handles the top edge).
		const n = firstBlock ? 0 : blanks;
		firstBlock = false;
		blanks = 0;
		return n ? ' style="margin-top:calc(' + n + ' * var(--pm-lh))"' : "";
	};

	while (i < lines.length) {
		const line = lines[i];
		if (/^\s*$/.test(line)) {
			blanks++;
			i++;
			continue;
		}

		// fenced code block
		const fence = line.match(/^```(.*)$/);
		if (fence) {
			const lang = (fence[1] || "").trim().split(/\s+/)[0];
			const langLabel = lang ? esc(lang.toUpperCase()) : "";
			const chrome =
				'<span class="cm-code-block-info" contenteditable="false" aria-hidden="true">' +
				'<span class="cm-code-block-lang-container">' +
				langLabel +
				"</span>" +
				'<button type="button" class="cm-code-block-copy-button" title="Copy code">' +
				COPY_SVG +
				"</button></span>";
			const buf = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				buf.push(esc(lines[i]));
				i++;
			}
			i++; // closing fence
			html += "<pre" + sep() + ">" + chrome + "<code>" + buf.join("\n") + "</code></pre>";
			continue;
		}

		// headings h1–h3
		const h = line.match(/^(#{1,3})\s+(.*)$/);
		if (h) {
			const n = h[1].length;
			html += "<h" + n + sep() + ">" + inline(h[2]) + "</h" + n + ">";
			i++;
			continue;
		}

		// unordered list — each item is its own source line (CM line-box); the
		// .pm-rendered li carries the per-item gap, ul carries the blank-line gap.
		// GFM task items (`- [ ]` / `- [x]`) render as a disabled checkbox.
		if (/^[-*]\s+/.test(line)) {
			html += "<ul" + sep() + ">";
			while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
				const item = lines[i].replace(/^[-*]\s+/, "");
				const tm = item.match(/^\[([ xX])\]\s+(.*)$/);
				if (tm) {
					const done = tm[1].toLowerCase() === "x";
					html +=
						'<li class="pm-task' +
						(done ? " pm-done" : "") +
						'">' +
						'<input type="checkbox" disabled' +
						(done ? " checked" : "") +
						">" +
						inline(tm[2]) +
						"</li>";
				} else {
					html += "<li>" + inline(item) + "</li>";
				}
				i++;
			}
			html += "</ul>";
			continue;
		}

		// blockquote — lines joined with <br> (each is its own CM line-box).
		if (/^>\s?/.test(line)) {
			const q = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) {
				q.push(lines[i].replace(/^>\s?/, ""));
				i++;
			}
			html += "<blockquote" + sep() + ">" + q.map(inline).join("<br>") + "</blockquote>";
			continue;
		}

		// paragraph — consecutive non-blank, non-structural lines. Each source line
		// becomes a <br> break (remark-breaks semantics), NOT a space-join, so the
		// read view matches CM's one-line-box-per-source-line layout.
		const para = [];
		while (
			i < lines.length &&
			!/^\s*$/.test(lines[i]) &&
			!/^(#{1,3}\s|[-*]\s|>\s?|```)/.test(lines[i])
		) {
			para.push(lines[i]);
			i++;
		}
		html += "<p" + sep() + ">" + para.map(inline).join("<br>") + "</p>";
	}

	// trailing blank lines (rare, but keep the doc's tail height stable)
	if (blanks > 0) {
		html +=
			'<div class="pm-trailing-blank" aria-hidden="true" style="height:calc(' +
			blanks +
			' * var(--pm-lh))"></div>';
	}
	return html;
}
