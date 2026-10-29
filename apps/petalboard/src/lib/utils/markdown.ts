import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";

/**
 * Converts markdown text to HTML while preserving line breaks Uses remark with GitHub Flavored
 * Markdown support
 *
 * @param markdown - The markdown text to convert
 * @returns HTML string
 */
export function renderMarkdown(markdown: string): string {
	if (!markdown) {
		return "";
	}

	try {
		// Process markdown with remark
		const result = remark()
			.use(remarkGfm) // GitHub Flavored Markdown (tables, strikethrough, task lists, etc.)
			.use(remarkHtml) // Convert to sanitized HTML
			.processSync(markdown);

		return String(result);
	} catch (error) {
		console.error("Error rendering markdown:", error);

		// Fallback to escaped plain text with line breaks preserved
		return markdown
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll("\n", "<br>");
	}
}
