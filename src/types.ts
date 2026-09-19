export interface BridgeConfig {
  histerUrl: string;
  accessToken: string;
  tagPrefix: string;
  syncMobile: boolean;
  pollIntervalMinutes: number;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  histerUrl: "http://127.0.0.1:4433",
  accessToken: "",
  tagPrefix: "stash",
  syncMobile: true,
  pollIntervalMinutes: 5,
};

export interface HisterAddRequest {
  url: string;
  title?: string;
  text?: string;
  html?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface HisterLabelRequest {
  url: string;
  label: string;
}

export interface BackfillProgress {
  total: number;
  processed: number;
  failed: number;
  inProgress: boolean;
  message?: string;
}

export interface HisterSearchResultItem {
  id: string;
  url: string;
  title: string;
  label?: string;
  created_at?: string;
}

export interface HisterSearchResponse {
  documents?: HisterSearchResultItem[];
  results?: HisterSearchResultItem[];
  total?: number;
}
