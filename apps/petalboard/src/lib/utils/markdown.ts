import { remark } from "remark";
import remarkHtml from "remark-html";
import remarkGfm from "remark-gfm";

/**
 * Converts markdown text to HTML while preserving line breaks
 * Uses remark with GitHub Flavored Markdown support
 * @param markdown - The markdown text to convert
 * @returns HTML string
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown) return "";

  try {
    // Process markdown with remark
    const result = remark()
      .use(remarkGfm) // GitHub Flavored Markdown (tables, strikethrough, task lists, etc.)
      .use(remarkHtml, { sanitize: false }) // Convert to HTML
      .processSync(markdown);

    return String(result);
  } catch (error) {
    console.error("Error rendering markdown:", error);
    // Fallback to plain text with line breaks preserved
    return markdown.replace(/\n/g, "<br>");
  }
}
