import { DEFAULT_CONFIG, type BridgeConfig } from "./types";

const histerUrlInput = document.getElementById("histerUrl") as HTMLInputElement;
const accessTokenInput = document.getElementById("accessToken") as HTMLInputElement;
const tagPrefixInput = document.getElementById("tagPrefix") as HTMLInputElement;
const syncMobileInput = document.getElementById("syncMobile") as HTMLInputElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

async function loadSettings(): Promise<void> {
  const stored = await browser.storage.local.get("bridge_config");
  const config: BridgeConfig = { ...DEFAULT_CONFIG, ...(stored.bridge_config || {}) };

  histerUrlInput.value = config.histerUrl;
  accessTokenInput.value = config.accessToken;
  tagPrefixInput.value = config.tagPrefix;
  syncMobileInput.checked = config.syncMobile;
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

  try {
    const headers: Record<string, string> = {};
    if (newConfig.accessToken) {
      headers["Authorization"] = `Bearer ${newConfig.accessToken}`;
    }

    const testRes = await fetch(`${newConfig.histerUrl.replace(/\/$/, "")}/api/health`, { headers });
    if (testRes.ok || testRes.status === 404 || testRes.status === 401) {
      await browser.storage.local.set({ bridge_config: newConfig });
      statusEl.className = "status success";
      statusEl.textContent = "Saved! Successfully reached Hister server.";
    } else {
      statusEl.className = "status error";
      statusEl.textContent = `Server reachable, but returned HTTP ${testRes.status}. Saved config.`;
      await browser.storage.local.set({ bridge_config: newConfig });
    }
  } catch (err) {
    statusEl.className = "status error";
    statusEl.textContent = `Could not reach ${newConfig.histerUrl} (saved anyway). Is Hister running?`;
    await browser.storage.local.set({ bridge_config: newConfig });
  }
}

document.addEventListener("DOMContentLoaded", loadSettings);
saveBtn.addEventListener("click", saveSettings);
