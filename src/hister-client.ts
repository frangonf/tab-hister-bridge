import { normalizeUrl } from "./bridge-core";

export interface HisterDocumentStatus {
  exists: boolean;
  actualUrl: string;
  hasText: boolean;
  label: string;
  metadata: Record<string, unknown>;
  lookupStatus?: number;
  matchedLegacyUrl?: boolean;
  legacyUrl?: string;
}

export interface HisterConnectionResult {
  reachable: boolean;
  authorized: boolean;
  status?: number;
}

export interface HisterRequestResult {
  ok: boolean;
  status?: number;
}

export interface HisterPdfDocument {
  url: string;
  title?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface HisterUpdateResult {
  ok: boolean;
  status?: number;
  actualUrl: string;
}

function candidateUrls(rawUrl: string): string[] {
  const canonicalUrl = normalizeUrl(rawUrl);
  return canonicalUrl === rawUrl ? [canonicalUrl] : [canonicalUrl, rawUrl];
}

export async function checkHisterConnection(
  fetchFn: typeof fetch,
  histerUrl: string,
  headers: Record<string, string>,
): Promise<HisterConnectionResult> {
  try {
    const sentinelUrl = "https://tab-hister-bridge.invalid/connection-check";
    const response = await fetchFn(
      `${histerUrl.replace(/\/$/, "")}/api/document?url=${encodeURIComponent(sentinelUrl)}`,
      { headers },
    );
    return {
      reachable: true,
      authorized: response.status !== 401 && response.status !== 403,
      status: response.status,
    };
  } catch {
    return { reachable: false, authorized: false };
  }
}

export async function getHisterDocument(
  fetchFn: typeof fetch,
  histerUrl: string,
  rawUrl: string,
  headers: Record<string, string>,
): Promise<HisterDocumentStatus> {
  const baseUrl = histerUrl.replace(/\/$/, "");
  const canonicalUrl = normalizeUrl(rawUrl);
  for (const candidate of candidateUrls(rawUrl)) {
    try {
      const response = await fetchFn(
        `${baseUrl}/api/document?url=${encodeURIComponent(candidate)}`,
        { headers },
      );
      if (response.status === 404) continue;
      if (!response.ok) {
        return {
          exists: false,
          actualUrl: candidate,
          hasText: false,
          label: "",
          metadata: {},
          lookupStatus: response.status,
        };
      }
      const document = (await response.json()) as {
        url?: unknown;
        text?: unknown;
        label?: unknown;
        metadata?: unknown;
      };
      let legacyUrl: string | undefined;
      if (candidate === canonicalUrl && canonicalUrl !== rawUrl) {
        try {
          const legacyResponse = await fetchFn(
            `${baseUrl}/api/document?url=${encodeURIComponent(rawUrl)}`,
            { headers },
          );
          if (legacyResponse.ok) legacyUrl = rawUrl;
        } catch {
          // The canonical document is usable even if duplicate detection fails.
        }
      }
      return {
        exists: true,
        actualUrl: typeof document.url === "string" ? document.url : candidate,
        hasText:
          typeof document.text === "string" && document.text.trim().length > 0,
        label: typeof document.label === "string" ? document.label : "",
        metadata:
          document.metadata && typeof document.metadata === "object"
            ? (document.metadata as Record<string, unknown>)
            : {},
        lookupStatus: response.status,
        matchedLegacyUrl: candidate !== canonicalUrl,
        legacyUrl,
      };
    } catch {
      return {
        exists: false,
        actualUrl: candidate,
        hasText: false,
        label: "",
        metadata: {},
      };
    }
  }
  return {
    exists: false,
    actualUrl: normalizeUrl(rawUrl),
    hasText: false,
    label: "",
    metadata: {},
    lookupStatus: 404,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export async function addHisterPdfRequest(
  fetchFn: typeof fetch,
  histerUrl: string,
  document: HisterPdfDocument,
  pdf: ArrayBuffer,
  headers: Record<string, string>,
): Promise<HisterRequestResult> {
  try {
    const response = await fetchFn(
      `${histerUrl.replace(/\/$/, "")}/api/add_pdf`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ document, pdf: arrayBufferToBase64(pdf) }),
      },
    );
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false };
  }
}

export async function deleteHisterDocumentRequest(
  fetchFn: typeof fetch,
  histerUrl: string,
  exactUrl: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    const escapedUrl = exactUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const response = await fetchFn(
      `${histerUrl.replace(/\/$/, "")}/api/delete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ query: `url:"${escapedUrl}"` }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function updateHisterLabelRequest(
  fetchFn: typeof fetch,
  histerUrl: string,
  rawUrl: string,
  label: string,
  headers: Record<string, string>,
): Promise<HisterUpdateResult> {
  const baseUrl = histerUrl.replace(/\/$/, "");
  for (const candidate of candidateUrls(rawUrl)) {
    try {
      const response = await fetchFn(`${baseUrl}/api/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ url: candidate, label }),
      });
      if (response.status === 404) continue;
      return { ok: response.ok, status: response.status, actualUrl: candidate };
    } catch {
      return { ok: false, actualUrl: candidate };
    }
  }
  return { ok: false, status: 404, actualUrl: normalizeUrl(rawUrl) };
}
