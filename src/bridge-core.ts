import type { ExtractedPage } from "./extractor";
import type { HisterAddRequest } from "./types";

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
    payload.metadata = { ...options.existingMetadata };
  }
  return payload;
}

export function sanitizeLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function computeStashLabel(
  folderPath: string[],
  tagPrefix: string
): string {
  const segments = folderPath
    .map(sanitizeLabel)
    .filter((segment) => segment && segment !== "tab-stash");
  return segments.length > 0
    ? `${tagPrefix}/${segments.join("/")}`
    : tagPrefix;
}

export type StashMoveAction = "none" | "apply" | "restore";

export function classifyStashMove(
  wasInside: boolean,
  isInside: boolean
): StashMoveAction {
  if (isInside) return "apply";
  return wasInside ? "restore" : "none";
}

export interface StashBookmark {
  id: string;
  url: string;
  title: string;
  folderPath: string[];
}

export function computeStashChanges(
  previous: ReadonlyMap<string, StashBookmark>,
  current: ReadonlyMap<string, StashBookmark>
): { removed: StashBookmark[]; changed: StashBookmark[] } {
  const removed = Array.from(previous.values()).filter((item) => !current.has(item.id));
  const changed = Array.from(current.values()).filter((item) => {
    const old = previous.get(item.id);
    return !old || old.url !== item.url || old.title !== item.title || old.folderPath.join("\0") !== item.folderPath.join("\0");
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
  return [...exact]
    .filter((candidate) => candidate.depth === minimumDepth)
    .sort((a, b) => {
      const byDate = (a.dateAdded ?? 0) - (b.dateAdded ?? 0);
      return byDate || a.id.localeCompare(b.id);
    })[0] ?? null;
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
        .replace(/[!'()*]/g, (character) =>
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
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
