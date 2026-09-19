import { checkHisterConnection } from "./hister-client";
import {
  DEFAULT_CONFIG,
  type BridgeConfig,
  type BackfillProgress,
} from "./types";

const histerUrlInput = document.getElementById("histerUrl") as HTMLInputElement;
const accessTokenInput = document.getElementById(
  "accessToken",
) as HTMLInputElement;
const tagPrefixInput = document.getElementById("tagPrefix") as HTMLInputElement;
const syncMobileInput = document.getElementById(
  "syncMobile",
) as HTMLInputElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

const backfillBtn = document.getElementById("backfillBtn") as HTMLButtonElement;
const backfillStatusEl = document.getElementById(
  "backfillStatus",
) as HTMLDivElement;
const searchStashesLink = document.getElementById(
  "searchStashesLink",
) as HTMLAnchorElement;
const openHisterLink = document.getElementById(
  "openHisterLink",
) as HTMLAnchorElement;

let pollTimer: number | null = null;

function updateQuickLinks(histerUrl: string, tagPrefix: string): void {
  const baseUrl = histerUrl.replace(/\/$/, "");
  const prefix = tagPrefix || "stash";
  if (searchStashesLink) {
    searchStashesLink.href = `${baseUrl}/?q=label:${encodeURIComponent(prefix)}/*`;
    searchStashesLink.textContent = `🔍 Search all stashed tabs in Hister (label:${prefix}/*) ↗`;
  }
  if (openHisterLink) {
    openHisterLink.href = baseUrl;
  }
}

async function loadSettings(): Promise<void> {
  const stored = (await browser.storage.local.get("bridge_config")) as {
    bridge_config?: Partial<BridgeConfig>;
  };
  const config: BridgeConfig = {
    ...DEFAULT_CONFIG,
    ...(stored.bridge_config ?? {}),
  };

  histerUrlInput.value = config.histerUrl;
  accessTokenInput.value = config.accessToken;
  tagPrefixInput.value = config.tagPrefix;
  syncMobileInput.checked = config.syncMobile;

  updateQuickLinks(config.histerUrl, config.tagPrefix);
  await checkBackfillStatus();
}

async function saveSettings(): Promise<void> {
  statusEl.className = "status";
  statusEl.textContent = "Testing connection...";

  const newConfig: BridgeConfig = {
    histerUrl: histerUrlInput.value.trim() || DEFAULT_CONFIG.histerUrl,
    accessToken: accessTokenInput.value.trim(),
    tagPrefix: tagPrefixInput.value.trim() || DEFAULT_CONFIG.tagPrefix,
    syncMobile: syncMobileInput.checked,
    pollIntervalMinutes: 5,
  };

  updateQuickLinks(newConfig.histerUrl, newConfig.tagPrefix);

  try {
    const headers: Record<string, string> = {};
    if (newConfig.accessToken) {
      headers["Authorization"] = `Bearer ${newConfig.accessToken}`;
    }

    const result = await checkHisterConnection(
      fetch,
      newConfig.histerUrl,
      headers,
    );
    await browser.storage.local.set({ bridge_config: newConfig });
    if (!result.reachable) {
      statusEl.className = "status error";
      statusEl.textContent = `Could not reach ${newConfig.histerUrl} (saved anyway). Is Hister running?`;
    } else if (!result.authorized) {
      statusEl.className = "status error";
      statusEl.textContent = `Hister rejected the access token (HTTP ${result.status}). Saved config.`;
    } else if (
      result.status === 404 ||
      (result.status !== undefined &&
        result.status >= 200 &&
        result.status < 300)
    ) {
      statusEl.className = "status success";
      statusEl.textContent = "Saved! Successfully connected to Hister.";
    } else {
      statusEl.className = "status error";
      statusEl.textContent = `Server reachable, but returned HTTP ${result.status}. Saved config.`;
    }
  } catch (error) {
    statusEl.className = "status error";
    statusEl.textContent = `Could not save settings: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function checkBackfillStatus(): Promise<void> {
  try {
    const res = (await browser.runtime.sendMessage({
      action: "get_status",
    })) as { backfill?: BackfillProgress } | undefined;
    if (res?.backfill) {
      renderBackfillProgress(res.backfill);
    }
  } catch {
    // Background service might be initializing
  }
}

function renderBackfillProgress(progress: BackfillProgress): void {
  if (progress.inProgress) {
    backfillBtn.disabled = true;
    backfillBtn.textContent = "Syncing in progress...";
    backfillStatusEl.textContent =
      progress.message ||
      `Processing (${progress.processed}/${progress.total})...`;

    if (!pollTimer) {
      pollTimer = window.setInterval(() => {
        void checkBackfillStatus();
      }, 1000);
    }
  } else {
    backfillBtn.disabled = false;
    backfillBtn.textContent = "Sync & Backfill Stashes";
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (progress.message) {
      backfillStatusEl.textContent = progress.message;
    }
  }
}

async function triggerBackfill(): Promise<void> {
  renderBackfillProgress({
    total: 0,
    processed: 0,
    failed: 0,
    inProgress: true,
    message: "Scanning bookmarks inside Tab Stash...",
  });

  try {
    const res = (await browser.runtime.sendMessage({
      action: "start_backfill",
    })) as { progress?: BackfillProgress } | undefined;
    if (res?.progress) {
      renderBackfillProgress(res.progress);
    }
  } catch (err) {
    backfillBtn.disabled = false;
    backfillBtn.textContent = "Sync & Backfill Stashes";
    backfillStatusEl.textContent = `Error starting backfill: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void loadSettings();
});
saveBtn.addEventListener("click", () => {
  void saveSettings();
});
backfillBtn.addEventListener("click", () => {
  void triggerBackfill();
});
