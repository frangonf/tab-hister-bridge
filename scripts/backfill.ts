import { DatabaseSync } from "node:sqlite";
import { Window } from "happy-dom";
import {
  buildHisterPayload,
  computeStashLabel,
  isSupportedPageUrl,
  normalizeUrl,
  selectTabStashRoot,
} from "../src/bridge-core";
import { DEFUDDLE_VERSION, extractPageContent, type ExtractedPage } from "../src/extractor";
import {
  deleteHisterDocumentRequest,
  getHisterDocument,
  updateHisterLabelRequest,
} from "../src/hister-client";

const win = new Window();
(globalThis as { DOMParser?: typeof DOMParser }).DOMParser = win.DOMParser as unknown as typeof DOMParser;

interface BookmarkItem {
  id: number;
  url: string;
  title: string;
  folderPath: string[];
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function pushToHister(options: {
  histerUrl: string;
  rawUrl: string;
  title: string;
  label: string;
  extraction: ExtractedPage;
  existingUrl?: string;
  existingMetadata?: Record<string, unknown>;
  matchedLegacyUrl?: boolean;
  token: string;
}): Promise<boolean> {
  const payload = buildHisterPayload({
    rawUrl: options.rawUrl,
    title: options.title,
    label: options.label,
    extraction: options.extraction,
    existingMetadata: options.existingMetadata,
    defuddleVersion: DEFUDDLE_VERSION,
  });
  if (options.existingUrl) payload.url = options.existingUrl;

  try {
    const response = await fetch(`${options.histerUrl.replace(/\/$/, "")}/api/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(options.token) },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return false;
    if (options.matchedLegacyUrl && options.existingUrl) {
      await deleteHisterDocumentRequest(
        fetch,
        options.histerUrl,
        options.existingUrl,
        authHeaders(options.token)
      );
    }
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const placesPath = process.env.PLACES_SQLITE || "dev-profile/places.sqlite";
  const histerUrl = process.env.HISTER_URL || "http://127.0.0.1:4433";
  const token = process.env.HISTER_TOKEN || "";
  const tagPrefix = process.env.TAG_PREFIX || "stash";
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  console.log(`[Backfill] Target Hister URL : ${histerUrl}`);
  console.log(`[Backfill] Database path     : ${placesPath}`);
  console.log(`[Backfill] Tag prefix        : ${tagPrefix}`);
  if (force) console.log("[Backfill] Mode              : FORCE (re-extracting all)");
  if (dryRun) console.log("[Backfill] Mode              : DRY RUN (no modifications)");
  console.log("------------------------------------------------------------");

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(`file:${placesPath}?immutable=1`, { readOnly: true });
  } catch (error) {
    console.error(`[Backfill] Failed to open places.sqlite at ${placesPath}:`, error);
    process.exit(1);
  }

  const roots = db
    .prepare("SELECT id, parent, title, dateAdded FROM moz_bookmarks WHERE title = 'Tab Stash' AND type = 2")
    .all() as Array<{ id: number; parent: number; title: string; dateAdded: number }>;
  const parentStatement = db.prepare("SELECT parent FROM moz_bookmarks WHERE id = ?");
  const rootCandidates = roots.map((root) => {
    let depth = 0;
    let parent = root.parent;
    while (parent > 0) {
      depth++;
      const row = parentStatement.get(parent) as { parent: number } | undefined;
      if (!row || row.parent === parent) break;
      parent = row.parent;
    }
    return {
      id: String(root.id),
      numericId: root.id,
      title: root.title,
      dateAdded: root.dateAdded,
      depth,
    };
  });
  const root = selectTabStashRoot(rootCandidates);
  if (!root) {
    console.error("[Backfill] No exact 'Tab Stash' folder found in database!");
    process.exit(1);
  }

  console.log(`[Backfill] Found Tab Stash root folder (ID: ${root.id})`);
  const getChildren = db.prepare(
    "SELECT b.id, b.type, b.title, b.parent, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id WHERE b.parent = ?"
  );
  const bookmarks: BookmarkItem[] = [];

  function walk(parentId: number, currentPath: string[]): void {
    const rows = getChildren.all(parentId) as Array<{
      id: number;
      type: number;
      title: string | null;
      parent: number;
      url: string | null;
    }>;
    for (const row of rows) {
      if (row.type === 2 && row.title) {
        walk(row.id, [...currentPath, row.title]);
      } else if (row.url && isSupportedPageUrl(row.url)) {
        bookmarks.push({
          id: row.id,
          url: row.url,
          title: row.title || row.url,
          folderPath: currentPath,
        });
      }
    }
  }

  walk(root.numericId, []);
  console.log(`[Backfill] Discovered ${bookmarks.length} stashed bookmarks.`);
  console.log("------------------------------------------------------------");

  let extractedCount = 0;
  let relabeledCount = 0;
  let upToDateCount = 0;
  let failedCount = 0;

  for (let index = 0; index < bookmarks.length; index++) {
    const item = bookmarks[index];
    const expectedLabel = computeStashLabel(item.folderPath, tagPrefix);
    const prefix = `[${index + 1}/${bookmarks.length}]`;
    const existing = await getHisterDocument(
      fetch,
      histerUrl,
      item.url,
      authHeaders(token)
    );
    if (existing.legacyUrl && !dryRun) {
      const deleted = await deleteHisterDocumentRequest(
        fetch,
        histerUrl,
        existing.legacyUrl,
        authHeaders(token)
      );
      if (!deleted) {
        console.warn(`${prefix} ⚠ Could not remove duplicate legacy URL`);
      }
    }
    const defuddleCurrent =
      existing.metadata.extractor === "defuddle" &&
      existing.metadata.extractor_version === DEFUDDLE_VERSION;

    if (!existing.exists && existing.lookupStatus !== 404) {
      console.warn(`${prefix} ✗ Failed to inspect existing Hister document`);
      failedCount++;
      continue;
    }

    if (!existing.exists || !existing.hasText || !defuddleCurrent || force) {
      console.log(`${prefix} ⚡ Extracting: "${item.title.slice(0, 45)}" -> ${expectedLabel}`);
      if (dryRun) {
        extractedCount++;
        continue;
      }

      try {
        const response = await fetch(item.url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          console.warn(`${prefix} ⚠️  HTTP ${response.status} fetching ${item.url}`);
          failedCount++;
          continue;
        }

        const extraction = extractPageContent(
          await response.text(),
          item.url,
          item.title
        );
        const ok = await pushToHister({
          histerUrl,
          rawUrl: item.url,
          title: item.title,
          label: expectedLabel,
          extraction,
          existingUrl: existing.exists ? existing.actualUrl : undefined,
          existingMetadata: existing.metadata,
          matchedLegacyUrl: existing.matchedLegacyUrl,
          token,
        });
        if (ok) {
          console.log(`${prefix} ✓ Ingested: "${extraction.title.slice(0, 40)}" (${extraction.text.length} chars text)`);
          extractedCount++;
        } else {
          console.warn(`${prefix} ✗ Failed to push to Hister: ${normalizeUrl(item.url)}`);
          failedCount++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`${prefix} ✗ Error extracting ${item.url}: ${message}`);
        failedCount++;
      }
    } else if (existing.label !== expectedLabel) {
      console.log(`${prefix} ↻ Relabeling: "${item.title.slice(0, 45)}" -> ${expectedLabel}`);
      if (dryRun) {
        relabeledCount++;
        continue;
      }
      const result = await updateHisterLabelRequest(
        fetch,
        histerUrl,
        existing.actualUrl,
        expectedLabel,
        authHeaders(token)
      );
      if (result.ok) relabeledCount++;
      else failedCount++;
    } else {
      console.log(`${prefix} = Up-to-date: "${item.title.slice(0, 45)}"`);
      upToDateCount++;
    }
  }

  console.log("------------------------------------------------------------");
  console.log(`[Backfill] Finished processing ${bookmarks.length} bookmarks:`);
  console.log(`  ✓ Extracted & indexed with Defuddle : ${extractedCount}`);
  console.log(`  ↻ Relabeled                         : ${relabeledCount}`);
  console.log(`  = Already up to date                : ${upToDateCount}`);
  console.log(`  ✗ Failed                            : ${failedCount}`);
}

main().catch((error: unknown) => {
  console.error("[Backfill] Fatal error:", error);
  process.exit(1);
});
