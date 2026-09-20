import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");

function job(name: string): string {
  const headers = [...workflow.matchAll(/^ {2}([\w-]+):$/gm)];
  const index = headers.findIndex((match) => match[1] === name);
  if (index === -1) throw new Error(`Workflow job ${name} was not found`);
  const start = headers[index].index;
  const end = headers[index + 1]?.index;
  return workflow.slice(start, end);
}

describe("release workflow", () => {
  test("provides explicit repository context to the checkout-free publish job", () => {
    expect(job("publish")).toContain("GH_REPO: ${{ github.repository }}");
  });
});
