import { describe, expect, it } from "vitest";
import {
  buildHisterPayload,
  classifyStashMove,
  computeStashChanges,
  isSupportedPageUrl,
  normalizeUrl,
  selectTabStashRoot,
} from "../src/bridge-core";

describe("isSupportedPageUrl", () => {
  it("accepts only HTTP and HTTPS pages", () => {
    expect(isSupportedPageUrl("https://example.com")).toBe(true);
    expect(isSupportedPageUrl("http://example.com")).toBe(true);
    expect(isSupportedPageUrl("file:///tmp/page.html")).toBe(false);
    expect(isSupportedPageUrl("about:blank")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("removes fragments and Hister tracking parameters while retaining other parameters", () => {
    expect(
      normalizeUrl("https://Example.com/page?utm_source=newsletter&keep=1&utm=legacy#section")
    ).toBe("https://Example.com/page?keep=1");
  });

  it("uses Go-compatible query escaping to match Hister URL identities", () => {
    expect(
      normalizeUrl("https://example.com/?utm=x&keep=~%20value")
    ).toBe("https://example.com/?keep=~+value");
  });
});

describe("selectTabStashRoot", () => {
  it("matches Tab Stash's exact-title, shallowest, oldest, lowest-ID ordering", () => {
    const selected = selectTabStashRoot([
      { id: "9", title: "Tab Stash backup", depth: 1, dateAdded: 1 },
      { id: "8", title: "Tab Stash", depth: 3, dateAdded: 1 },
      { id: "7", title: "Tab Stash", depth: 2, dateAdded: 20 },
      { id: "6", title: "Tab Stash", depth: 2, dateAdded: 10 },
      { id: "5", title: "Tab Stash", depth: 2, dateAdded: 10 },
    ]);

    expect(selected?.id).toBe("5");
  });
});

describe("computeStashChanges", () => {
  it("returns deleted descendants from the previous tree snapshot", () => {
    const previous = new Map([
      ["a", { id: "a", url: "https://a.test", title: "A", folderPath: ["Group"] }],
      ["b", { id: "b", url: "https://b.test", title: "B", folderPath: ["Group", "Nested"] }],
    ]);

    const changes = computeStashChanges(previous, new Map());

    expect(changes.removed.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("detects a folder-path change for an existing bookmark", () => {
    const previous = new Map([
      ["a", { id: "a", url: "https://a.test", title: "A", folderPath: ["Old"] }],
    ]);
    const current = new Map([
      ["a", { id: "a", url: "https://a.test", title: "A", folderPath: ["New"] }],
    ]);

    expect(computeStashChanges(previous, current).changed).toEqual([
      current.get("a"),
    ]);
  });
});

describe("classifyStashMove", () => {
  it.each([
    [false, false, "none"],
    [false, true, "apply"],
    [true, true, "apply"],
    [true, false, "restore"],
  ] as const)(
    "classifies old inside=%s and new inside=%s as %s",
    (wasInside, isInside, expected) => {
      expect(classifyStashMove(wasInside, isInside)).toBe(expected);
    }
  );
});

describe("buildHisterPayload", () => {
  it("submits canonical clean HTML for normal Hister processing without internal flags", () => {
    const payload = buildHisterPayload({
      rawUrl: "https://example.com/page?utm_source=x#part",
      title: "Example",
      label: "stash/research",
      extraction: {
        title: "Extracted",
        text: "Body",
        cleanHtml: "<article>Body</article>",
        extractedByDefuddle: true,
      },
      existingMetadata: { author: "A" },
      defuddleVersion: "0.19.4",
    });

    expect(payload).toEqual({
      url: "https://example.com/page",
      title: "Extracted",
      text: "Body",
      html: "<article>Body</article>",
      label: "stash/research",
      metadata: { author: "A", extractor: "defuddle", extractor_version: "0.19.4" },
    });
    expect(payload).not.toHaveProperty("processed");
    expect(payload).not.toHaveProperty("labels");
    expect(payload).not.toHaveProperty("domain");
    expect(payload).not.toHaveProperty("language");
  });

  it("does not mark fallback HTML as Defuddle-extracted", () => {
    const payload = buildHisterPayload({
      rawUrl: "https://example.com",
      title: "Example",
      label: "stash",
      extraction: {
        title: "Example",
        text: "",
        cleanHtml: "<html>raw fallback</html>",
        extractedByDefuddle: false,
      },
      existingMetadata: { source: "existing" },
      defuddleVersion: "0.19.4",
    });

    expect(payload.metadata).toEqual({ source: "existing" });
    expect(payload.html).toBe("<html>raw fallback</html>");
  });
});
