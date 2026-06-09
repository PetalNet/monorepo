// The ProseMark read-view markdown renderer, ported verbatim from the source
// design page's <script> so the rendered HTML is byte-identical (keeps the
// read/edit swap shift-free and the page pixel-identical). It runs at SSR for
// the static read view AND in the browser to re-render after edits.

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const CODE_SENTINEL = "CODE";

function inline(raw: string): string {
	const codes: string[] = [];
	let s = raw.replace(/`([^`]+)`/g, (_, c) => {
		codes.push(esc(c));
		return CODE_SENTINEL + (codes.length - 1) + CODE_SENTINEL;
	});
	s = esc(s);
	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, url) =>
		!/^(https?:\/\/|\/|#)/i.test(url) ? t : '<a href="' + url + '" rel="noopener">' + t + "</a>",
	);
	s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
	s = s.replace(
		new RegExp(CODE_SENTINEL + "(\\d+)" + CODE_SENTINEL, "g"),
		(_, i) => "<code>" + codes[+i] + "</code>",
	);
	return s;
}

export function renderMd(src: string): string {
	const lines = src.split("\n");
	let html = "",
		i = 0;
	let blanks = 0,
		firstBlock = true;
	const sep = () => {
		const n = firstBlock ? 0 : Math.max(1, blanks);
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
		const fence = line.match(/^```(.*)$/);
		if (fence) {
			const lang = (fence[1] || "").trim().split(/\s+/)[0];
			const langLabel = lang ? esc(lang.toUpperCase()) : "";
			const COPY_SVG =
				'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy-icon lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
			const chrome =
				'<span class="cm-code-block-info" contenteditable="false" aria-hidden="true"><span class="cm-code-block-lang-container">' +
				langLabel +
				'</span><button type="button" class="cm-code-block-copy-button" title="Copy code">' +
				COPY_SVG +
				"</button></span>";
			const buf: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				buf.push(esc(lines[i]));
				i++;
			}
			i++;
			html += "<pre" + sep() + ">" + chrome + "<code>" + buf.join("\n") + "</code></pre>";
			continue;
		}
		const h = line.match(/^(#{1,3})\s+(.*)$/);
		if (h) {
			const n = h[1].length;
			html += "<h" + n + sep() + ">" + inline(h[2]) + "</h" + n + ">";
			i++;
			continue;
		}
		if (/^[-*]\s+/.test(line)) {
			html += "<ul" + sep() + ">";
			while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
				html += "<li>" + inline(lines[i].replace(/^[-*]\s+/, "")) + "</li>";
				i++;
			}
			html += "</ul>";
			continue;
		}
		if (/^>\s?/.test(line)) {
			const q: string[] = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) {
				q.push(lines[i].replace(/^>\s?/, ""));
				i++;
			}
			html +=
				"<blockquote" +
				sep() +
				'><span class="bq-mark">&gt; </span>' +
				inline(q.join(" ")) +
				"</blockquote>";
			continue;
		}
		const para: string[] = [];
		while (
			i < lines.length &&
			!/^\s*$/.test(lines[i]) &&
			!/^(#{1,3}\s|[-*]\s|>\s?|```)/.test(lines[i])
		) {
			para.push(lines[i]);
			i++;
		}
		html += "<p" + sep() + ">" + inline(para.join(" ")) + "</p>";
	}
	if (blanks > 0)
		html +=
			'<div class="pm-trailing-blank" aria-hidden="true" style="height:calc(' +
			blanks +
			' * var(--pm-lh))"></div>';
	return html;
}
