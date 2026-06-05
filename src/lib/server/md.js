import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';

// Markdown -> SANITIZED HTML for {@html}. Bodies come from the web form, the MCP
// tools, and the Corner sync mirror — all untrusted — and tasks sits behind shared
// SSO, so unsanitized HTML was a stored-XSS hole.
//
// remark-rehype is used WITHOUT allowDangerousHtml, so raw HTML in a body (e.g.
// <script>, <img onerror>) never enters the hast tree at all — it's dropped at the
// parse boundary, not scrubbed after the fact. rehype-sanitize (GitHub's allowlist
// schema) is the belt-and-suspenders pass on top. gfm gives tables/strikethrough/
// task-lists/autolinks. processSync keeps callers synchronous (no async plugins).
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeStringify);

export function renderMd(src) {
  if (!src) return '';
  return String(processor.processSync(src));
}
