import { DEFAULT_CONFIG, type BridgeConfig, type HisterAddRequest, type HisterSearchResponse } from "./types";

let config: BridgeConfig = { ...DEFAULT_CONFIG };
let tabStashRootId: string | null = null;

// Load configuration from extension storage
async function loadConfig(): Promise<void> {
  try {
    const stored = await browser.storage.local.get("bridge_config");
    if (stored && stored.bridge_config) {
      config = { ...DEFAULT_CONFIG, ...(stored.bridge_config as Partial<BridgeConfig>) };
    }
  } catch (err) {
    console.error("[Bridge] Failed to load config, using defaults", err);
  }
}

// Find the ID of the "Tab Stash" root folder in Firefox Bookmarks
async function findTabStashRoot(): Promise<string | null> {
  if (tabStashRootId) return tabStashRootId;

  try {
    const results = await browser.bookmarks.search({ title: "Tab Stash" });
    for (const item of results) {
      if (!item.url) {
        tabStashRootId = item.id;
        return item.id;
      }
    }
  } catch (err) {
    console.error("[Bridge] Error searching for Tab Stash root folder", err);
  }

  return null;
}

// Check if a given bookmark is inside the "Tab Stash" folder hierarchy
async function isInsideTabStash(parentId: string | undefined): Promise<{ inside: boolean; path: string[] }> {
  if (!parentId) return { inside: false, path: [] };

  const rootId = await findTabStashRoot();
  const path: string[] = [];
  let currentId: string | undefined = parentId;

  while (currentId) {
    if (rootId && currentId === rootId) {
      return { inside: true, path: path.reverse() };
    }

    try {
      const nodes = await browser.bookmarks.get(currentId);
      if (!nodes || nodes.length === 0) break;
      const node = nodes[0];
      if (node.title) {
        path.push(node.title);
      }
      currentId = node.parentId;
    } catch {
      break;
    }
  }

  return { inside: false, path: [] };
}

// Clean label string for Hister (lowercase, hyphenated)
function sanitizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^\w-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// Push a single stashed bookmark to Hister daemon
async function pushToHister(url: string, title: string, folderPath: string[]): Promise<boolean> {
  if (!url || !url.startsWith("http")) return false;

  const labels: string[] = [config.tagPrefix];
  for (const segment of folderPath) {
    const clean = sanitizeLabel(segment);
    if (clean && clean !== "tab-stash") {
      labels.push(`${config.tagPrefix}/${clean}`);
      labels.push(clean);
    }
  }

  const payload: HisterAddRequest = {
    url,
    title: title || url,
    labels: Array.from(new Set(labels)),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.accessToken) {
    headers["Authorization"] = `Bearer ${config.accessToken}`;
  }

  try {
    const endpoint = `${config.histerUrl.replace(/\/$/, "")}/api/add`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      console.log(`[Bridge] Successfully sent to Hister: ${url} (${labels.join(", ")})`);
      return true;
    } else {
      console.warn(`[Bridge] Hister API returned ${res.status} for ${url}`);
      return false;
    }
  } catch (err) {
    console.error(`[Bridge] Network error sending to Hister (${config.histerUrl}):`, err);
    return false;
  }
}

// Listen to new bookmarks created in Firefox
browser.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (!bookmark.url) return; // Ignore folders

  const { inside, path } = await isInsideTabStash(bookmark.parentId);
  if (inside) {
    console.log(`[Bridge] Detected stash: "${bookmark.title}" inside [${path.join(" > ")}]`);
    await pushToHister(bookmark.url, bookmark.title, path);
  }
});

// Periodic sync for mobile stashes (Inbound from Hister -> Firefox Bookmarks)
async function syncMobileStashes(): Promise<void> {
  if (!config.syncMobile) return;

  const rootId = await findTabStashRoot();
  if (!rootId) return;

  try {
    const query = encodeURIComponent(`label:${config.tagPrefix}:mobile`);
    const endpoint = `${config.histerUrl.replace(/\/$/, "")}/search?q=${query}&limit=50`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (config.accessToken) {
      headers["Authorization"] = `Bearer ${config.accessToken}`;
    }

    const res = await fetch(endpoint, { headers });
    if (!res.ok) return;

    const data = (await res.json()) as HisterSearchResponse;
    const items = data.documents || data.results || [];
    if (items.length === 0) return;

    // Ensure "Mobile Inbox" folder exists under Tab Stash root
    const existing = await browser.bookmarks.getChildren(rootId);
    let mobileInbox = existing.find((child) => child.title === "Mobile Inbox" && !child.url);

    if (!mobileInbox) {
      mobileInbox = await browser.bookmarks.create({
        parentId: rootId,
        title: "Mobile Inbox",
      });
    }

    for (const item of items) {
      // Check if bookmark already exists
      const found = await browser.bookmarks.search({ url: item.url });
      if (found.length === 0) {
        await browser.bookmarks.create({
          parentId: mobileInbox.id,
          title: item.title || item.url,
          url: item.url,
        });
        console.log(`[Bridge] Ingested mobile stash into Desktop: ${item.url}`);
      }

      // Relabel in Hister as synced
      try {
        await fetch(`${config.histerUrl.replace(/\/$/, "")}/api/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({
            url: item.url,
            labels: (item.labels || []).map((l) => (l === `${config.tagPrefix}:mobile` ? `${config.tagPrefix}:synced` : l)),
          }),
        });
      } catch (err) {
        console.error(`[Bridge] Failed to update synced status for ${item.url}`, err);
      }
    }
  } catch (err) {
    console.error("[Bridge] Error during mobile stash poll:", err);
  }
}

// Initialize alarms and background service
browser.alarms.create("poll_mobile_stashes", { periodInMinutes: 5 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll_mobile_stashes") {
    syncMobileStashes();
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridge_config) {
    config = { ...DEFAULT_CONFIG, ...(changes.bridge_config.newValue as Partial<BridgeConfig>) };
    console.log("[Bridge] Configuration updated:", config);
  }
});

// Startup run
loadConfig().then(() => {
  console.log("[Bridge] Extension initialized and listening for Tab Stash bookmarks.");
  syncMobileStashes();
});
