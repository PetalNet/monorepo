import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

// Markdown -> SANITIZED HTML for {@html}. Bodies come from the web form, the MCP
// tools, and the import sync mirror — all untrusted — and tasks sits behind shared
// SSO, so unsanitized HTML was a stored-XSS hole.
//
// remark-rehype is used WITHOUT allowDangerousHtml, so raw HTML in a body (e.g.
// <script>, <img onerror>) never enters the hast tree at all — it's dropped at the
// parse boundary, not scrubbed after the fact. rehype-sanitize (GitHub's allowlist
// schema) is the belt-and-suspenders pass on top. gfm gives tables/strikethrough/
// task-lists/autolinks. processSync keeps callers synchronous (no async plugins).
//
// [[wikilinks]] (task-514): a rehype pass (rehypeWikilinks) runs AFTER remark-rehype
// but BEFORE sanitize, so the nodes it creates (`a`/`span`) go through the same
// allowlist as everything else. We only ever emit relative /task/N hrefs and a fixed
// set of class names, both of which the extended schema below permits — no new XSS
// surface. Sanitize runs last regardless, so even a bug here can't leak raw HTML.

// Fleet agent handles (lab personas). A handle resolves to a /fleet/<handle> page
// ONLY when that route exists; today it doesn't, so handles render as a styled-but-
// inert span (visually marked, not a dead link). Flip FLEET_ROUTE_EXISTS when the
// /fleet/[handle] route lands and the same code starts emitting real links.
const FLEET_AGENTS = new Set(["agent-b", "claude", "agent-c", "agent-a", "agent-e", "agent-d", "import"]);
const FLEET_ROUTE_EXISTS = false;

// [[...]] tokens. Inner text is captured loosely (no ]] inside) and classified below.
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

// Resolve one [[inner]] token to a hast element node (link or span). Returns null
// when the token is empty/whitespace so the literal text is left untouched.
function resolveWikilink(inner) {
	const raw = inner.trim();

	if (!raw) return null;

	// task-N / #N  -> real link to the task page.
	const taskMatch = /^(?:task-|#)(\d+)$/i.exec(raw);

	if (taskMatch) {
		const n = taskMatch[1];

		return el("a", { href: `/task/${n}`, className: ["wikilink", "wl-task"] }, `task-${n}`);
	}

	// Bare handle (no spaces/slashes) that matches a known fleet agent.
	const handle = raw.toLowerCase();

	if (/^[a-z0-9][a-z0-9_-]*$/i.test(raw) && FLEET_AGENTS.has(handle)) {
		if (FLEET_ROUTE_EXISTS) {
			return el("a", { href: `/fleet/${handle}`, className: ["wikilink", "wl-agent"] }, raw);
		}

		return el("span", { className: ["wikilink", "wl-agent"], title: "fleet agent" }, raw);
	}

	// Any other slug -> subtle inert wikilink span (marks intent, not a broken link).
	return el("span", { className: ["wikilink", "wl-ref"] }, raw);
}

function el(tagName, properties, text) {
	return {
		type: "element",
		tagName,
		properties,
		children: [{ type: "text", value: text }],
	};
}

// Split a text node's value on [[...]] and return the replacement node list (text +
// element nodes). Returns null when there's nothing to replace.
function splitText(value) {
	WIKILINK_RE.lastIndex = 0;

	if (!WIKILINK_RE.test(value)) return null;

	WIKILINK_RE.lastIndex = 0;

	const out = [];
	let last = 0;
	let m;

	while ((m = WIKILINK_RE.exec(value))) {
		const node = resolveWikilink(m[1]);

		if (!node) continue; // empty token: leave literal text in place

		if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });

		out.push(node);
		last = m.index + m[0].length;
	}

	if (!out.length) return null;

	if (last < value.length) out.push({ type: "text", value: value.slice(last) });

	return out;
}

// rehype transform: rewrite [[...]] inside text nodes. Skips code/pre so [[...]] in a
// code span stays literal.
function rehypeWikilinks() {
	return (tree) => {
		const walk = (node) => {
			const kids = node.children;

			if (!kids) return;

			for (let i = 0; i < kids.length; i++) {
				const child = kids[i];

				if (child.type === "element") {
					// don't rewrite inside existing links or code spans
					if (child.tagName === "code" || child.tagName === "pre" || child.tagName === "a")
						continue;

					walk(child);
				} else if (child.type === "text") {
					const replacement = splitText(child.value);

					if (replacement) {
						kids.splice(i, 1, ...replacement);
						i += replacement.length - 1;
					}
				}
			}
		};

		walk(tree);
	};
}

// Extend GitHub's allowlist so our wikilink nodes survive sanitize: permit the fixed
// class names on `a`/`span` and a `title` on `span`. Everything else stays default.
const WL_CLASSES = ["wikilink", "wl-task", "wl-agent", "wl-ref"];

// Merge our allowed class names into an element's attribute list. hast-util-sanitize
// honours a SINGLE className rule per element, so we extend the existing tuple in
// place (a second ['className', ...] entry would be ignored and silently strip ours).
function withWikilinkClasses(attrs = []) {
	const out = [];
	let merged = false;

	for (const a of attrs) {
		if (Array.isArray(a) && a[0] === "className") {
			out.push(["className", ...a.slice(1), ...WL_CLASSES]);
			merged = true;
		} else if (a === "className") {
			out.push(["className", ...WL_CLASSES]);
			merged = true;
		} else {
			out.push(a);
		}
	}

	if (!merged) out.push(["className", ...WL_CLASSES]);

	return out;
}

const schema = {
	...defaultSchema,
	tagNames: defaultSchema.tagNames.includes("span")
		? defaultSchema.tagNames
		: [...defaultSchema.tagNames, "span"],
	attributes: {
		...defaultSchema.attributes,
		a: withWikilinkClasses(defaultSchema.attributes.a),
		span: [...withWikilinkClasses(defaultSchema.attributes.span), "title"],
	},
};

const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	// Treat a single newline as a hard line break (GitHub-comment semantics). Bodies,
	// docs, ideas and comments are typed in a form where people EXPECT their line breaks
	// to survive; plain markdown collapses a lone "\n" into a space, which read as the
	// app "eating whitespace". Runs after gfm, before rehype, so the breaks are real
	// mdast nodes that still go through sanitize.
	.use(remarkBreaks)
	.use(remarkRehype)
	.use(rehypeWikilinks)
	.use(rehypeSanitize, schema)
	.use(rehypeStringify);

export function renderMd(src) {
	if (!src) return "";

	return String(processor.processSync(src));
}

// Plan headings carry their state in plain markdown, so authors can edit them in
// any markdown editor. The marker becomes a semantic, visible pill only at render.
export function renderPlanMd(src) {
	return renderMd(src).replace(
		/(<h[1-6]>)(.*?)(\s*\{status=(proposed|decided|done)\})(<\/h[1-6]>)/g,
		(_match, open, title, _marker, status, close) =>
			`${open}${title}<span class="plan-status plan-status-${status}">${status}</span>${close}`,
	);
}
