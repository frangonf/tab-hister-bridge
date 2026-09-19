import {
  DEFAULT_CONFIG,
  type BackfillProgress,
  type BridgeConfig,
  type HisterAddRequest,
  type HisterSearchResponse,
} from "./types";
import {
  buildHisterPayload,
  buildStashUrlCounts,
  classifyFetchedContent,
  classifyStashMove,
  computeStashChanges,
  computeStashLabel as buildStashLabel,
  isSupportedPageUrl,
  normalizeUrl,
  selectTabStashRoot,
  shouldSubmitFetchedContent,
  shouldUpdateLabel,
  updateStashSnapshot,
  withoutDefuddleMetadata,
  type StashBookmark,
} from "./bridge-core";
import { startBackgroundJob } from "./backfill-job";
import { DEFUDDLE_VERSION, extractPageContent } from "./extractor";
import {
  addHisterPdfRequest,
  deleteHisterDocumentRequest,
  getHisterDocument,
  updateHisterLabelRequest,
  type HisterDocumentStatus,
  type HisterUpdateResult,
} from "./hister-client";

const PREVIOUS_LABELS_KEY = "bridge_previous_labels";

let config: BridgeConfig = { ...DEFAULT_CONFIG };
let tabStashRootId: string | null = null;
let stashSnapshot = new Map<string, StashBookmark>();
let stashUrlCounts = new Map<string, number>();
let snapshotInitialized = false;
let previousLabels: Record<string, string> = {};
let eventQueue: Promise<void> = Promise.resolve();
const pendingMobileUrls = new Map<string, number>();

let currentBackfill: BackfillProgress = {
  total: 0,
  processed: 0,
  failed: 0,
  inProgress: false,
};
let backfillPromise: Promise<BackfillProgress> | null = null;

function authHeaders(): Record<string, string> {
  return config.accessToken
    ? { Authorization: `Bearer ${config.accessToken}` }
    : {};
}

async function loadState(): Promise<void> {
  try {
    const stored = await browser.storage.local.get([
      "bridge_config",
      PREVIOUS_LABELS_KEY,
    ]);
    config = {
      ...DEFAULT_CONFIG,
      ...(stored.bridge_config as Partial<BridgeConfig> | undefined),
    };
    previousLabels =
      stored[PREVIOUS_LABELS_KEY] &&
      typeof stored[PREVIOUS_LABELS_KEY] === "object"
        ? { ...(stored[PREVIOUS_LABELS_KEY] as Record<string, string>) }
        : {};
  } catch (error) {
    console.error("[Bridge] Failed to load state, using defaults", error);
  }
}

async function savePreviousLabels(): Promise<void> {
  await browser.storage.local.set({ [PREVIOUS_LABELS_KEY]: previousLabels });
}

function invalidateTabStashRoot(): void {
  tabStashRootId = null;
}

async function bookmarkDepth(
  node: browser.bookmarks.BookmarkTreeNode,
): Promise<number> {
  let depth = 0;
  let parentId = node.parentId;
  while (parentId) {
    depth++;
    const [parent] = await browser.bookmarks.get(parentId);
    parentId = parent?.parentId;
  }
  return depth;
}

export async function findTabStashRoot(): Promise<string | null> {
  if (tabStashRootId) {
    try {
      const [cached] = await browser.bookmarks.get(tabStashRootId);
      if (cached && !cached.url && cached.title === "Tab Stash") {
        return tabStashRootId;
      }
    } catch {
      // Recompute below.
    }
    tabStashRootId = null;
  }

  try {
    const results = await browser.bookmarks.search({ title: "Tab Stash" });
    const folders = results.filter(
      (item) => !item.url && item.title === "Tab Stash",
    );
    const candidates = await Promise.all(
      folders.map(async (item) => ({
        id: item.id,
        title: item.title,
        dateAdded: item.dateAdded,
        depth: await bookmarkDepth(item),
      })),
    );
    tabStashRootId = selectTabStashRoot(candidates)?.id ?? null;
  } catch (error) {
    tabStashRootId = null;
    console.error("[Bridge] Error searching for Tab Stash root folder", error);
    throw error;
  }
  return tabStashRootId;
}

export async function isInsideTabStash(
  parentId: string | undefined,
): Promise<{ inside: boolean; path: string[] }> {
  if (!parentId) return { inside: false, path: [] };

  const rootId = await findTabStashRoot();
  const path: string[] = [];
  let currentId: string | undefined = parentId;

  while (currentId) {
    if (rootId && currentId === rootId) {
      return { inside: true, path: path.reverse() };
    }
    const [node] = await browser.bookmarks.get(currentId);
    if (!node) break;
    if (node.title) path.push(node.title);
    currentId = node.parentId;
  }
  return { inside: false, path: [] };
}

export function computeStashLabel(folderPath: string[]): string {
  return buildStashLabel(folderPath, config.tagPrefix);
}

function isManagedLabel(label: string): boolean {
  return (
    label === config.tagPrefix ||
    label.startsWith(`${config.tagPrefix}/`) ||
    label === `${config.tagPrefix}:mobile` ||
    label === `${config.tagPrefix}:synced`
  );
}

async function rememberPreviousLabel(
  rawUrl: string,
  status: HisterDocumentStatus,
  targetLabel: string,
): Promise<void> {
  const key = normalizeUrl(rawUrl);
  if (
    !status.exists ||
    Object.prototype.hasOwnProperty.call(previousLabels, key) ||
    status.label === targetLabel ||
    isManagedLabel(status.label)
  ) {
    return;
  }
  previousLabels[key] = status.label;
  await savePreviousLabels();
}

function markPendingMobileUrl(rawUrl: string): void {
  const key = normalizeUrl(rawUrl);
  pendingMobileUrls.set(key, (pendingMobileUrls.get(key) ?? 0) + 1);
}

function isPendingMobileUrl(rawUrl: string): boolean {
  return (pendingMobileUrls.get(normalizeUrl(rawUrl)) ?? 0) > 0;
}

function consumePendingMobileUrl(rawUrl: string): boolean {
  const key = normalizeUrl(rawUrl);
  const count = pendingMobileUrls.get(key) ?? 0;
  if (count === 0) return false;
  if (count === 1) pendingMobileUrls.delete(key);
  else pendingMobileUrls.set(key, count - 1);
  return true;
}

function unmarkPendingMobileUrl(rawUrl: string): void {
  consumePendingMobileUrl(rawUrl);
}

type FetchedPageContent =
  { kind: "html"; html: string } | { kind: "pdf"; bytes: ArrayBuffer };

async function fetchPageContent(
  rawUrl: string,
): Promise<FetchedPageContent | null> {
  const urlLooksLikePdf = classifyFetchedContent(rawUrl, null) === "pdf";
  if (!urlLooksLikePdf) {
    try {
      const tabs = await browser.tabs.query({ url: rawUrl });
      for (const tab of tabs) {
        if (tab.id && tab.status === "complete") {
          try {
            const results = await browser.scripting.executeScript({
              target: { tabId: tab.id },
              func: () =>
                JSON.stringify({
                  html: document.documentElement.outerHTML,
                  contentType: document.contentType,
                }) as unknown as void,
            });
            if (typeof results?.[0]?.result === "string") {
              const page = JSON.parse(results[0].result) as {
                html?: unknown;
                contentType?: unknown;
              };
              if (
                typeof page.html === "string" &&
                classifyFetchedContent(
                  rawUrl,
                  typeof page.contentType === "string"
                    ? page.contentType
                    : null,
                ) === "html"
              ) {
                return { kind: "html", html: page.html };
              }
            }
          } catch {
            // Privileged pages cannot be scripted; use the network fallback.
          }
        }
      }
    } catch {
      // An invalid tab match pattern should not prevent the network fallback.
    }
  }

  try {
    const response = await fetch(rawUrl, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const kind = classifyFetchedContent(
      rawUrl,
      response.headers.get("Content-Type"),
    );
    if (kind === "pdf") {
      return { kind, bytes: await response.arrayBuffer() };
    }
    if (kind === "html") {
      return { kind, html: await response.text() };
    }
    console.warn(
      `[Bridge] Unsupported content type for ${rawUrl}: ${response.headers.get("Content-Type") ?? "unknown"}`,
    );
    return null;
  } catch (error) {
    console.warn(`[Bridge] Background fetch failed for ${rawUrl}:`, error);
    return null;
  }
}

export async function getHisterDocumentStatus(
  rawUrl: string,
): Promise<HisterDocumentStatus> {
  const status = await getHisterDocument(
    fetch,
    config.histerUrl,
    rawUrl,
    authHeaders(),
  );
  if (status.legacyUrl) {
    const deleted = await deleteHisterDocumentRequest(
      fetch,
      config.histerUrl,
      status.legacyUrl,
      authHeaders(),
    );
    if (!deleted) {
      console.warn(
        `[Bridge] Could not remove duplicate legacy identity ${status.legacyUrl}`,
      );
    }
  }
  return status;
}

export async function updateHisterLabel(
  rawUrl: string,
  newLabel: string,
): Promise<HisterUpdateResult> {
  const result = await updateHisterLabelRequest(
    fetch,
    config.histerUrl,
    rawUrl,
    newLabel,
    authHeaders(),
  );
  if (result.ok) {
    console.log(
      `[Bridge] Updated label for ${result.actualUrl} -> "${newLabel}"`,
    );
  } else if (result.status !== 404) {
    console.warn(
      `[Bridge] Failed to update label for ${rawUrl}: ${result.status ?? "network error"}`,
    );
  }
  return result;
}

export async function pushToHister(
  rawUrl: string,
  title: string,
  folderPath: string[],
  knownStatus?: HisterDocumentStatus,
): Promise<boolean> {
  if (!isSupportedPageUrl(rawUrl)) return false;

  const status = knownStatus ?? (await getHisterDocumentStatus(rawUrl));
  if (!status.exists && status.lookupStatus !== 404) {
    console.warn(
      `[Bridge] Cannot inspect existing Hister document for ${rawUrl}`,
    );
    return false;
  }
  const label = computeStashLabel(folderPath);
  await rememberPreviousLabel(rawUrl, status, label);

  const fetched = await fetchPageContent(rawUrl);
  const extraction =
    fetched?.kind === "html"
      ? extractPageContent(fetched.html, rawUrl, title)
      : null;
  if (
    !shouldSubmitFetchedContent(
      status.exists && status.hasText,
      fetched?.kind ?? null,
      extraction?.extractedByDefuddle === true,
    )
  ) {
    if (!status.exists) return false;
    if (!shouldUpdateLabel(status.label, label)) return true;
    return (await updateHisterLabel(status.actualUrl, label)).ok;
  }

  let responseStatus: number | undefined;
  if (fetched?.kind === "pdf") {
    const pdfResult = await addHisterPdfRequest(
      fetch,
      config.histerUrl,
      {
        url: status.exists ? status.actualUrl : normalizeUrl(rawUrl),
        title,
        label,
        metadata: withoutDefuddleMetadata(status.metadata),
      },
      fetched.bytes,
      authHeaders(),
    );
    responseStatus = pdfResult.status;
    if (!pdfResult.ok) {
      console.warn(
        `[Bridge] Hister PDF API returned ${responseStatus ?? "network error"} for ${rawUrl}`,
      );
      return false;
    }
  } else {
    const payload: HisterAddRequest = buildHisterPayload({
      rawUrl,
      title,
      label,
      extraction,
      existingMetadata: status.metadata,
      defuddleVersion: DEFUDDLE_VERSION,
    });
    // Let Hister normalize legacy identities through its standard ingestion path.
    if (status.exists) payload.url = status.actualUrl;

    try {
      const endpoint = `${config.histerUrl.replace(/\/$/, "")}/api/add`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      responseStatus = response.status;
      if (!response.ok) {
        console.warn(
          `[Bridge] Hister API returned ${response.status} for ${rawUrl}`,
        );
        return false;
      }
    } catch (error) {
      console.error(
        `[Bridge] Network error sending to Hister (${config.histerUrl}):`,
        error,
      );
      return false;
    }
  }

  try {
    const canonicalUrl = normalizeUrl(rawUrl);
    if (status.matchedLegacyUrl) {
      const deleted = await deleteHisterDocumentRequest(
        fetch,
        config.histerUrl,
        status.actualUrl,
        authHeaders(),
      );
      if (!deleted) {
        console.warn(
          `[Bridge] Indexed ${canonicalUrl}, but could not remove legacy identity ${status.actualUrl}`,
        );
      }
    }
    console.log(
      `[Bridge] Successfully sent to Hister: ${canonicalUrl} (${label}, HTTP ${responseStatus})`,
    );
    return true;
  } catch (error) {
    console.error(`[Bridge] Legacy URL cleanup failed for ${rawUrl}:`, error);
    return true;
  }
}

async function applyStashLabel(item: StashBookmark): Promise<boolean> {
  if (!isSupportedPageUrl(item.url)) return true;
  const label = computeStashLabel(item.folderPath);
  const status = await getHisterDocumentStatus(item.url);
  await rememberPreviousLabel(item.url, status, label);
  if (!status.exists) {
    return status.lookupStatus === 404
      ? pushToHister(item.url, item.title, item.folderPath, status)
      : false;
  }
  if (!shouldUpdateLabel(status.label, label)) return true;

  const result = await updateHisterLabel(status.actualUrl, label);
  if (result.ok) return true;
  if (result.status === 404) {
    return pushToHister(item.url, item.title, item.folderPath);
  }
  return false;
}

async function restorePreviousLabel(item: StashBookmark): Promise<boolean> {
  const canonicalUrl = normalizeUrl(item.url);
  if ((stashUrlCounts.get(canonicalUrl) ?? 0) > 0) return true;

  const label = Object.prototype.hasOwnProperty.call(
    previousLabels,
    canonicalUrl,
  )
    ? previousLabels[canonicalUrl]
    : "";
  const result = await updateHisterLabel(item.url, label);
  if (result.ok || result.status === 404) {
    delete previousLabels[canonicalUrl];
    await savePreviousLabels();
    return true;
  }
  return false;
}

async function collectSubtreeBookmarks(
  folderId: string,
  folderPath: string[],
  target: Map<string, StashBookmark>,
): Promise<void> {
  const children = await browser.bookmarks.getChildren(folderId);
  for (const child of children) {
    if (child.url) {
      if (isSupportedPageUrl(child.url)) {
        target.set(child.id, {
          id: child.id,
          url: child.url,
          title: child.title || child.url,
          folderPath,
        });
      }
    } else {
      await collectSubtreeBookmarks(
        child.id,
        [...folderPath, child.title],
        target,
      );
    }
  }
}

export async function collectTabStashBookmarks(): Promise<StashBookmark[]> {
  const rootId = await findTabStashRoot();
  if (!rootId) return [];
  const items = new Map<string, StashBookmark>();
  await collectSubtreeBookmarks(rootId, [], items);
  return Array.from(items.values());
}

async function currentStashMap(): Promise<Map<string, StashBookmark>> {
  return new Map(
    (await collectTabStashBookmarks()).map((item) => [item.id, item]),
  );
}

async function ensureSnapshot(): Promise<void> {
  if (snapshotInitialized) return;
  stashSnapshot = await currentStashMap();
  stashUrlCounts = buildStashUrlCounts(stashSnapshot);
  snapshotInitialized = true;
}

async function reconcileStashTree(): Promise<void> {
  await ensureSnapshot();
  const previous = stashSnapshot;
  invalidateTabStashRoot();
  const current = await currentStashMap();
  const changes = computeStashChanges(previous, current);
  stashSnapshot = current;
  stashUrlCounts = buildStashUrlCounts(stashSnapshot);

  const restoredUrls = new Set<string>();
  for (const item of changes.removed) {
    const canonicalUrl = normalizeUrl(item.url);
    if (restoredUrls.has(canonicalUrl)) continue;
    restoredUrls.add(canonicalUrl);
    await restorePreviousLabel(item);
  }
  for (const item of changes.changed) {
    if (!isPendingMobileUrl(item.url)) {
      await applyStashLabel(item);
    }
  }
}

function enqueueBookmarkTask(task: () => Promise<void>): Promise<void> {
  eventQueue = eventQueue
    .then(task)
    .catch((error) => console.error("[Bridge] Bookmark event failed:", error));
  return eventQueue;
}

function registerBookmarkListeners(): void {
  browser.bookmarks.onCreated.addListener((id, bookmark) => {
    void enqueueBookmarkTask(async () => {
      await ensureSnapshot();
      if (!bookmark.url) {
        if (bookmark.title === "Tab Stash") {
          await reconcileStashTree();
        }
        return;
      }
      const location = await isInsideTabStash(bookmark.parentId);
      if (!location.inside || !isSupportedPageUrl(bookmark.url)) return;
      const item: StashBookmark = {
        id,
        url: bookmark.url,
        title: bookmark.title || bookmark.url,
        folderPath: location.path,
      };
      if (consumePendingMobileUrl(bookmark.url)) {
        stashSnapshot = updateStashSnapshot(
          stashSnapshot,
          item,
          undefined,
          stashUrlCounts,
        );
        return;
      }
      await pushToHister(bookmark.url, bookmark.title, location.path);
      stashSnapshot = updateStashSnapshot(
        stashSnapshot,
        item,
        undefined,
        stashUrlCounts,
      );
    });
  });

  browser.bookmarks.onMoved.addListener((id, moveInfo) => {
    void enqueueBookmarkTask(async () => {
      await ensureSnapshot();
      const [node] = await browser.bookmarks.get(id);
      if (!node) return;
      if (!node.url) {
        await reconcileStashTree();
        return;
      }

      const oldLocation = await isInsideTabStash(moveInfo.oldParentId);
      const newLocation = await isInsideTabStash(moveInfo.parentId);
      const item: StashBookmark = {
        id,
        url: node.url,
        title: node.title || node.url,
        folderPath: newLocation.path,
      };

      const action = classifyStashMove(oldLocation.inside, newLocation.inside);
      if (action === "apply" && isSupportedPageUrl(item.url)) {
        await applyStashLabel(item);
        stashSnapshot = updateStashSnapshot(
          stashSnapshot,
          item,
          undefined,
          stashUrlCounts,
        );
      } else if (action === "restore") {
        const previous = stashSnapshot.get(id) ?? {
          ...item,
          folderPath: oldLocation.path,
        };
        const current = updateStashSnapshot(
          stashSnapshot,
          null,
          id,
          stashUrlCounts,
        );
        await restorePreviousLabel(previous);
        stashSnapshot = current;
      }
    });
  });

  browser.bookmarks.onChanged.addListener((id) => {
    void enqueueBookmarkTask(async () => {
      await ensureSnapshot();
      const [node] = await browser.bookmarks.get(id);
      if (!node) return;
      if (!node.url) {
        await reconcileStashTree();
        return;
      }

      const old = stashSnapshot.get(id);
      const location = await isInsideTabStash(node.parentId);
      if (!old && !location.inside) return;
      const item: StashBookmark = {
        id,
        url: node.url,
        title: node.title || node.url,
        folderPath: location.path,
      };
      const supported = isSupportedPageUrl(node.url);
      const current =
        location.inside && supported
          ? updateStashSnapshot(stashSnapshot, item, undefined, stashUrlCounts)
          : updateStashSnapshot(stashSnapshot, null, id, stashUrlCounts);
      if (
        old &&
        (normalizeUrl(old.url) !== normalizeUrl(node.url) ||
          !location.inside ||
          !supported)
      ) {
        await restorePreviousLabel(old);
      }
      if (location.inside && supported) {
        await pushToHister(node.url, node.title, location.path);
      }
      stashSnapshot = current;
    });
  });

  browser.bookmarks.onRemoved.addListener((id, removeInfo) => {
    void enqueueBookmarkTask(async () => {
      await ensureSnapshot();
      const old = stashSnapshot.get(id);
      if (old) {
        const current = updateStashSnapshot(
          stashSnapshot,
          null,
          id,
          stashUrlCounts,
        );
        await restorePreviousLabel(old);
        stashSnapshot = current;
      } else if (!removeInfo.node.url) {
        // A folder removal can remove many cached descendants in one event.
        await reconcileStashTree();
      }
    });
  });
}

export async function runBackfill(): Promise<BackfillProgress> {
  if (backfillPromise) return backfillPromise;

  currentBackfill = {
    total: 0,
    processed: 0,
    failed: 0,
    inProgress: true,
    message: "Discovering Tab Stash bookmarks...",
  };
  backfillPromise = (async () => {
    const stashes = await collectTabStashBookmarks();
    currentBackfill = {
      total: stashes.length,
      processed: 0,
      failed: 0,
      inProgress: true,
      message: `Starting backfill of ${stashes.length} items...`,
    };

    for (let index = 0; index < stashes.length; index++) {
      const item = stashes[index];
      currentBackfill.message = `Processing (${index + 1}/${stashes.length}): ${item.title.slice(0, 40)}`;
      try {
        const status = await getHisterDocumentStatus(item.url);
        const targetLabel = computeStashLabel(item.folderPath);
        const defuddleCurrent =
          status.metadata.extractor === "defuddle" &&
          status.metadata.extractor_version === DEFUDDLE_VERSION;
        const likelyPdf = classifyFetchedContent(item.url, null) === "pdf";
        let ok: boolean;
        if (!status.exists && status.lookupStatus !== 404) {
          ok = false;
        } else if (
          !status.exists ||
          !status.hasText ||
          !defuddleCurrent ||
          likelyPdf
        ) {
          ok = await pushToHister(
            item.url,
            item.title,
            item.folderPath,
            status,
          );
        } else {
          await rememberPreviousLabel(item.url, status, targetLabel);
          ok = shouldUpdateLabel(status.label, targetLabel)
            ? (await updateHisterLabel(status.actualUrl, targetLabel)).ok
            : true;
        }
        if (ok) currentBackfill.processed++;
        else currentBackfill.failed++;
      } catch (error) {
        console.error(`[Bridge] Error backfilling ${item.url}:`, error);
        currentBackfill.failed++;
      }
    }

    currentBackfill.inProgress = false;
    currentBackfill.message = `Completed: ${currentBackfill.processed} synced, ${currentBackfill.failed} failed.`;
    return currentBackfill;
  })().finally(() => {
    backfillPromise = null;
  });

  return backfillPromise;
}

async function syncMobileStashes(): Promise<void> {
  if (!config.syncMobile) return;
  const rootId = await findTabStashRoot();
  if (!rootId) return;

  try {
    const query = encodeURIComponent(`label:${config.tagPrefix}:mobile`);
    const endpoint = `${config.histerUrl.replace(/\/$/, "")}/search?q=${query}&limit=50`;
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json", ...authHeaders() },
    });
    if (!response.ok) return;

    const data = (await response.json()) as HisterSearchResponse;
    const items = data.documents || data.results || [];
    if (items.length === 0) return;

    const existing = await browser.bookmarks.getChildren(rootId);
    let mobileInbox = existing.find(
      (child) => child.title === "Mobile Inbox" && !child.url,
    );
    if (!mobileInbox) {
      mobileInbox = await browser.bookmarks.create({
        parentId: rootId,
        title: "Mobile Inbox",
      });
    }

    for (const item of items) {
      const found = await browser.bookmarks.search({ url: item.url });
      if (found.length === 0) {
        markPendingMobileUrl(item.url);
        try {
          await browser.bookmarks.create({
            parentId: mobileInbox.id,
            title: item.title || item.url,
            url: item.url,
          });
        } catch (error) {
          unmarkPendingMobileUrl(item.url);
          throw error;
        }
      }
      await updateHisterLabel(item.url, `${config.tagPrefix}:synced`);
    }
  } catch (error) {
    console.error("[Bridge] Error during mobile stash poll:", error);
  }
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const action =
    message && typeof message === "object" && "action" in message
      ? (message as { action?: string }).action
      : undefined;
  if (action === "get_status") {
    return Promise.resolve({
      backfill: currentBackfill,
      histerUrl: config.histerUrl,
    });
  }
  if (action === "start_backfill") {
    const acknowledgement = startBackgroundJob(
      async () => {
        await startup;
        await runBackfill();
      },
      {
        progress: {
          ...currentBackfill,
          inProgress: true,
          message: "Backfill queued...",
        },
      },
      (error) => {
        console.error("[Bridge] Backfill failed:", error);
        currentBackfill = {
          ...currentBackfill,
          inProgress: false,
          failed: Math.max(1, currentBackfill.failed),
          message: `Backfill failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      },
    );
    return Promise.resolve(acknowledgement);
  }
  return false;
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll_mobile_stashes") {
    void startup
      .then(() => syncMobileStashes())
      .catch((error) =>
        console.error("[Bridge] Mobile sync could not start:", error),
      );
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridge_config) {
    config = {
      ...DEFAULT_CONFIG,
      ...(changes.bridge_config.newValue as Partial<BridgeConfig>),
    };
    void browser.alarms.create("poll_mobile_stashes", {
      periodInMinutes: config.pollIntervalMinutes,
    });
  }
});

const startup = loadState().then(async () => {
  registerBookmarkListeners();
  await ensureSnapshot();
  void browser.alarms.create("poll_mobile_stashes", {
    periodInMinutes: config.pollIntervalMinutes,
  });
  console.log(
    "[Bridge] Extension initialized and listening for Tab Stash bookmarks.",
  );
  await syncMobileStashes();
});

void startup.catch((error) => {
  console.error("[Bridge] Extension initialization failed:", error);
});
