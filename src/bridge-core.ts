import type { ExtractedPage } from "./extractor";
import type { HisterAddRequest } from "./types";

export function withoutDefuddleMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const cleaned = { ...(metadata ?? {}) };
  if (cleaned.extractor === "defuddle") {
    delete cleaned.extractor;
    delete cleaned.extractor_version;
  }
  return cleaned;
}

export function buildHisterPayload(options: {
  rawUrl: string;
  title: string;
  label: string;
  extraction: ExtractedPage | null;
  existingMetadata?: Record<string, unknown>;
  defuddleVersion: string;
}): HisterAddRequest {
  const { extraction } = options;
  const payload: HisterAddRequest = {
    url: normalizeUrl(options.rawUrl),
    title: extraction?.title || options.title || options.rawUrl,
    label: options.label,
  };

  if (extraction?.cleanHtml) {
    payload.text = extraction.text;
    payload.html = extraction.cleanHtml;
  }
  if (extraction?.extractedByDefuddle) {
    payload.metadata = {
      ...(options.existingMetadata ?? {}),
      extractor: "defuddle",
      extractor_version: options.defuddleVersion,
    };
  } else if (options.existingMetadata) {
    payload.metadata = withoutDefuddleMetadata(options.existingMetadata);
  }
  return payload;
}

export function sanitizeLabel(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .normalize("NFC");
}

export function computeStashLabel(folderPath: string[], tagPrefix: string): string {
  const segments = folderPath
    .map(sanitizeLabel)
    .filter((segment) => segment && segment !== "tab-stash");
  return segments.length > 0 ? `${tagPrefix}/${segments.join("/")}` : tagPrefix;
}

export function shouldUpdateLabel(currentLabel: string, targetLabel: string): boolean {
  return currentLabel !== targetLabel;
}

export type StashMoveAction = "none" | "apply" | "restore";

export function classifyStashMove(wasInside: boolean, isInside: boolean): StashMoveAction {
  if (isInside) return "apply";
  return wasInside ? "restore" : "none";
}

export interface StashBookmark {
  id: string;
  url: string;
  title: string;
  folderPath: string[];
}

function adjustStashUrlCount(
  counts: Map<string, number>,
  rawUrl: string,
  adjustment: 1 | -1,
): void {
  const url = normalizeUrl(rawUrl);
  const next = (counts.get(url) ?? 0) + adjustment;
  if (next > 0) counts.set(url, next);
  else counts.delete(url);
}

export function buildStashUrlCounts(
  snapshot: ReadonlyMap<string, StashBookmark>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of snapshot.values()) {
    adjustStashUrlCount(counts, item.url, 1);
  }
  return counts;
}

export function updateStashSnapshot(
  snapshot: Map<string, StashBookmark>,
  item: StashBookmark | null,
  removedId?: string,
  urlCounts?: Map<string, number>,
): Map<string, StashBookmark> {
  const replacedId = removedId ?? item?.id;
  const previous = replacedId ? snapshot.get(replacedId) : undefined;
  if (previous && urlCounts) adjustStashUrlCount(urlCounts, previous.url, -1);
  if (removedId) snapshot.delete(removedId);
  if (item) {
    snapshot.set(item.id, item);
    if (urlCounts) adjustStashUrlCount(urlCounts, item.url, 1);
  }
  return snapshot;
}

export function computeStashChanges(
  previous: ReadonlyMap<string, StashBookmark>,
  current: ReadonlyMap<string, StashBookmark>,
): { removed: StashBookmark[]; changed: StashBookmark[] } {
  const removed = Array.from(previous.values()).filter((item) => !current.has(item.id));
  const changed = Array.from(current.values()).filter((item) => {
    const old = previous.get(item.id);
    return (
      !old ||
      old.url !== item.url ||
      old.title !== item.title ||
      old.folderPath.join("\0") !== item.folderPath.join("\0")
    );
  });
  return { removed, changed };
}

export interface StashRootCandidate {
  id: string;
  title: string;
  depth: number;
  dateAdded?: number;
}

export function selectTabStashRoot<T extends StashRootCandidate>(candidates: T[]): T | null {
  const exact = candidates.filter((candidate) => candidate.title === "Tab Stash");
  if (exact.length === 0) return null;

  const minimumDepth = Math.min(...exact.map((candidate) => candidate.depth));
  return (
    [...exact]
    .filter((candidate) => candidate.depth === minimumDepth)
    .sort((a, b) => {
      const byDate = (a.dateAdded ?? 0) - (b.dateAdded ?? 0);
      return byDate || a.id.localeCompare(b.id);
      })[0] ?? null
  );
}

export type FetchedContentKind = "html" | "pdf" | "unsupported";

export function shouldSubmitFetchedContent(
  documentHasContent: boolean,
  kind: Exclude<FetchedContentKind, "unsupported"> | null,
  extractedByDefuddle: boolean,
): boolean {
  if (kind === null) return false;
  if (kind === "pdf") return true;
  return !documentHasContent || extractedByDefuddle;
}

export function classifyFetchedContent(
  rawUrl: string,
  contentType: string | null,
): FetchedContentKind {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() || "";
  let pdfPath = false;
  try {
    pdfPath = new URL(rawUrl).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    // URL validation is handled separately.
  }
  if (mediaType === "application/pdf" || pdfPath) return "pdf";
  if (
    mediaType === "" ||
    mediaType.startsWith("text/") ||
    mediaType === "application/xhtml+xml" ||
    mediaType === "application/xml"
  ) {
    return "html";
  }
  return "unsupported";
}

export function isSupportedPageUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeUrl(rawUrl: string): string {
  try {
    // Validate without using URL.toString(), which canonicalizes more than
    // Hister's normalizeWebURL (for example, host casing and default ports).
    new URL(rawUrl);
    const hashIndex = rawUrl.indexOf("#");
    const withoutFragment = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
    const queryIndex = withoutFragment.indexOf("?");
    if (queryIndex < 0) return withoutFragment;

    const base = withoutFragment.slice(0, queryIndex);
    const rawQuery = withoutFragment.slice(queryIndex + 1);
    const params = new URLSearchParams(rawQuery);
    let removedTracking = false;
    for (const key of Array.from(params.keys())) {
      if (key === "utm" || key.startsWith("utm_")) {
        params.delete(key);
        removedTracking = true;
      }
    }
    if (!removedTracking) return withoutFragment;

    // Go's url.Values.Encode, used by Hister, sorts query keys and uses
    // QueryEscape rather than URLSearchParams' application/x-www-form-urlencoded
    // escaping (notably, Go leaves "~" unescaped).
    params.sort();
    const goQueryEscape = (value: string): string =>
      encodeURIComponent(value)
        .replace(
          /[!'()*]/g,
          (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        )
        .replace(/%20/g, "+");
    const query = Array.from(params.entries())
      .map(([key, value]) => `${goQueryEscape(key)}=${goQueryEscape(value)}`)
      .join("&");
    return query ? `${base}?${query}` : base;
  } catch {
    return rawUrl;
  }
}
