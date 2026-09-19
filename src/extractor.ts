import Defuddle from "defuddle";

export const DEFUDDLE_VERSION = "0.19.4";

export interface ExtractedPage {
  title: string;
  text: string;
  cleanHtml: string;
  extractedByDefuddle: boolean;
  description?: string;
  author?: string;
  site?: string;
}

/** Convert Defuddle's clean HTML content into plain text for full-text indexing. */
export function contentToPlainText(content: string): string {
  if (!content) return "";
  const withoutTags = content.replace(/<[^>]+>/g, " ");
  const decoded = new DOMParser().parseFromString(withoutTags, "text/html").body.textContent || "";
  return (
    decoded
    // Remove markdown links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove images ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // Remove code block markers
    .replace(/```[a-z0-9_-]*\n([\s\S]*?)```/gi, "$1")
    // Remove inline code
    .replace(/`([^`]+)`/g, "$1")
    // Remove markdown headers, bold, italics, blockquotes, bullets
    .replace(/^[#>\s*+-]+/gm, " ")
    .replace(/[*_~=]/g, " ")
    // Collapse multiple spaces/newlines
    .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Extract clean title, HTML, and plain text from an HTML document.
 * Operates natively via DOMParser in WebExtension environments and happy-dom test runners.
 */
export function extractPageContent(
  html: string,
  url: string,
  fallbackTitle?: string,
): ExtractedPage {
  if (!html || !html.trim()) {
    return {
      title: fallbackTitle || url,
      text: "",
      cleanHtml: "",
      extractedByDefuddle: false,
    };
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const def = new Defuddle(doc, { url });
    const res = def.parse();

    const title = res.title?.trim() || fallbackTitle || url;
    const cleanHtml = res.content || "";
    const text = contentToPlainText(cleanHtml);
    if (!text) {
      return {
        title,
        text: "",
        cleanHtml: html,
        extractedByDefuddle: false,
      };
    }

    return {
      title,
      text,
      cleanHtml,
      extractedByDefuddle: true,
      description: res.description,
      author: res.author,
      site: res.site,
    };
  } catch (err) {
    console.warn(`[Extractor] Defuddle failed on ${url}, falling back to basic metadata:`, err);
    return {
      title: fallbackTitle || url,
      text: "",
      cleanHtml: html,
      extractedByDefuddle: false,
    };
  }
}
