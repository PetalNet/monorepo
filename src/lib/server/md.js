import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

// Render markdown -> SANITIZED HTML for {@html}. Bodies come from the web form,
// the MCP tools, and the Corner sync mirror — all untrusted — and tasks sits behind
// shared SSO, so raw marked output (which passes <script>/onerror/javascript: through)
// was a stored-XSS hole. Allowlist tags/attrs; drop scripts, event handlers, and
// dangerous URL schemes.
const OPTS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'ul', 'ol', 'li', 'blockquote',
    'code', 'pre', 'em', 'strong', 'del', 'hr', 'br', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel'],
    img: ['src', 'alt', 'title'],
    td: ['align'],
    th: ['align']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  // force-safe links
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' })
  }
};

export function renderMd(src) {
  if (!src) return '';
  return sanitizeHtml(marked.parse(src, { breaks: true }), OPTS);
}
