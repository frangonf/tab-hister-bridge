import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  DEFUDDLE_VERSION,
  extractPageContent,
  contentToPlainText,
} from "../src/extractor";

describe("Defuddle Extractor Module", () => {
  it("keeps the extraction marker aligned with the pinned Defuddle dependency", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: { defuddle: string };
    };
    expect(packageJson.dependencies.defuddle).toBe(DEFUDDLE_VERSION);
  });

  it("converts formatted content to clean plain text", () => {
    const md =
      "## Title\n\nThis is [a link](https://example.com) with **bold** and `inline code`.\n\n* Bullet 1\n* Bullet 2";
    const plain = contentToPlainText(md);
    expect(plain).toBe(
      "Title This is a link with bold and inline code. Bullet 1 Bullet 2",
    );
  });

  it("decodes HTML entities while preserving spacing between blocks", () => {
    expect(
      contentToPlainText("<p>Rock &amp; roll</p><p>A&nbsp;B &#39;C&#39;</p>"),
    ).toBe("Rock & roll A B 'C'");
  });

  it("extracts clean title, HTML, and text from an HTML string", () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Open Source AI Chip Design</title>
          <meta name="description" content="Accelerated synthesis for AI accelerators">
          <meta name="author" content="Jane Doe">
        </head>
        <body>
          <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
          <main>
            <article>
              <h1>Open Source AI Chip Design</h1>
              <p>Designing modern hardware accelerators requires agile tooling and open architectures.</p>
              <p>By using domain-specific languages, engineers can iterate significantly faster.</p>
            </article>
          </main>
          <footer><p>Copyright 2026</p></footer>
        </body>
      </html>
    `;

    const result = extractPageContent(
      sampleHtml,
      "https://example.com/hardware-design",
    );

    expect(result.title).toBe("Open Source AI Chip Design");
    expect(result.author).toBe("Jane Doe");
    expect(result.cleanHtml).toContain(
      "Designing modern hardware accelerators",
    );
    expect(result.cleanHtml).not.toContain("Copyright 2026"); // stripped boilerplate
    expect(result.text).toContain("agile tooling and open architectures");
  });

  it("treats empty dynamic shells as failed extraction", () => {
    const html =
      '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>';
    const result = extractPageContent(html, "https://app.example", "App");

    expect(result.extractedByDefuddle).toBe(false);
    expect(result.text).toBe("");
    expect(result.cleanHtml).toBe(html);
  });

  it("does not mistake an HTML document beginning with a comment for Markdown", () => {
    const result = extractPageContent(
      "<!-- build --><!doctype html><html><head><title>Expected</title></head><body><nav>Noise</nav><main><h1>Article</h1><p>Body</p></main></body></html>",
      "https://example.com/article",
      "Fallback",
    );

    expect(result.title).toBe("Expected");
    expect(result.cleanHtml).not.toContain("<nav>");
  });
});
