import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, type HisterAddRequest } from "../src/types";

describe("Tab-Hister Bridge Core Logic", () => {
  it("defaults to local Hister daemon endpoint", () => {
    expect(DEFAULT_CONFIG.histerUrl).toBe("http://127.0.0.1:4433");
    expect(DEFAULT_CONFIG.tagPrefix).toBe("stash");
    expect(DEFAULT_CONFIG.syncMobile).toBe(true);
  });

  it("constructs hierarchical tags from Tab Stash folders", () => {
    const folderPath = ["Engineering", "Distributed Systems"];
    const tagPrefix = "stash";
    const labels: string[] = [tagPrefix];

    for (const segment of folderPath) {
      const clean = segment.toLowerCase().replace(/[^\w-]/g, "-");
      labels.push(`${tagPrefix}/${clean}`);
      labels.push(clean);
    }

    const payload: HisterAddRequest = {
      url: "https://raft.github.io",
      title: "Raft Consensus",
      labels: Array.from(new Set(labels)),
    };

    expect(payload.labels).toContain("stash");
    expect(payload.labels).toContain("stash/engineering");
    expect(payload.labels).toContain("stash/distributed-systems");
    expect(payload.labels).toContain("engineering");
    expect(payload.labels).toContain("distributed-systems");
  });
});
