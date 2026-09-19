import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, type HisterAddRequest } from "../src/types";

describe("Tab-Hister Bridge Core Logic", () => {
  it("defaults to local Hister daemon endpoint", () => {
    expect(DEFAULT_CONFIG.histerUrl).toBe("http://127.0.0.1:4433");
    expect(DEFAULT_CONFIG.tagPrefix).toBe("stash");
    expect(DEFAULT_CONFIG.syncMobile).toBe(true);
  });

  it("constructs clean hierarchical tag from Tab Stash folders", () => {
    const folderPath = ["Engineering", "Distributed Systems"];
    const tagPrefix = "stash";
    const segments = folderPath
      .map((s) => s.toLowerCase().replace(/[^\w-]/g, "-"))
      .filter(Boolean);

    const label = `${tagPrefix}/${segments.join("/")}`;

    const payload: HisterAddRequest = {
      url: "https://raft.github.io",
      title: "Raft Consensus",
      label,
    };

    expect(payload.label).toBe("stash/engineering/distributed-systems");
  });
});
