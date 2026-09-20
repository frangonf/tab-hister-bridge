import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const releaseScript = resolve("scripts/release.ts");
const tsx = resolve("node_modules/.bin/tsx");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createReleaseRepository(): {
  commandLog: string;
  fakeBin: string;
  remote: string;
  worktree: string;
} {
  const root = mkdtempSync(join(tmpdir(), "tab-hister-release-"));
  const remote = join(root, "remote.git");
  const worktree = join(root, "worktree");
  const fakeBin = join(root, "bin");
  const commandLog = join(root, "commands.log");

  mkdirSync(fakeBin);
  writeFileSync(commandLog, "");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", worktree);
  git(worktree, "config", "user.name", "Release Test");
  git(worktree, "config", "user.email", "release@example.com");
  writeFileSync(
    join(worktree, "manifest.json"),
    JSON.stringify({ version: "0.1.0" }),
  );
  git(worktree, "add", "manifest.json");
  git(worktree, "commit", "-m", "initial");
  git(worktree, "remote", "add", "origin", remote);
  git(worktree, "push", "--set-upstream", "origin", "main");

  writeExecutable(
    join(fakeBin, "mise"),
    `#!/bin/sh\nprintf 'mise %s\\n' "$*" >> "$FAKE_COMMAND_LOG"\n`,
  );
  writeExecutable(
    join(fakeBin, "gh"),
    `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
if [ "$1 $2" = "auth status" ] && [ "$FAKE_GH_AUTH_FAIL" = "1" ]; then
  exit 1
fi
if [ "$1 $2" = "run list" ]; then
  if [ "$FAKE_DELAY_RUN" = "1" ] && [ ! -f "$FAKE_RUN_STATE" ]; then
    touch "$FAKE_RUN_STATE"
    printf '[]\\n'
  else
    printf '[{"databaseId":123,"url":"https://example.test/actions/runs/123","headSha":"%s"}]\\n' "$FAKE_HEAD"
  fi
fi
`,
  );
  writeExecutable(
    join(fakeBin, "sleep"),
    `#!/bin/sh\nprintf 'sleep %s\\n' "$*" >> "$FAKE_COMMAND_LOG"\n`,
  );

  return { commandLog, fakeBin, remote, worktree };
}

function runRelease(
  repository: ReturnType<typeof createReleaseRepository>,
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(tsx, [releaseScript], {
    cwd: repository.worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_COMMAND_LOG: repository.commandLog,
      FAKE_HEAD: git(repository.worktree, "rev-parse", "HEAD"),
      FAKE_RUN_STATE: `${repository.commandLog}.run-state`,
      PATH: `${repository.fakeBin}:${process.env.PATH}`,
      ...env,
    },
  });
}

describe("release script", () => {
  test("verifies, tags, pushes, and watches the manifest version", () => {
    const repository = createReleaseRepository();
    const result = runRelease(repository);

    expect(result.status, result.stderr).toBe(0);
    expect(git(repository.worktree, "tag", "--list")).toBe("v0.1.0");
    expect(git(repository.remote, "tag", "--list")).toBe("v0.1.0");
    expect(readFileSync(repository.commandLog, "utf8")).toContain(
      "mise run verify",
    );
    expect(readFileSync(repository.commandLog, "utf8")).toContain(
      "gh run watch 123 --exit-status",
    );
    expect(result.stdout).toContain(
      "Approve the protected release environment when prompted",
    );
  });

  test("refuses to release from a branch other than main", () => {
    const repository = createReleaseRepository();
    git(repository.worktree, "switch", "-c", "feature");

    const result = runRelease(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Releases must run from the main branch");
    expect(git(repository.worktree, "tag", "--list")).toBe("");
    expect(readFileSync(repository.commandLog, "utf8")).not.toContain("mise");
  });

  test("refuses to release with uncommitted changes", () => {
    const repository = createReleaseRepository();
    writeFileSync(join(repository.worktree, "uncommitted.txt"), "dirty");

    const result = runRelease(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("working tree must be clean");
    expect(git(repository.worktree, "tag", "--list")).toBe("");
  });

  test("refuses to release when main does not match origin/main", () => {
    const repository = createReleaseRepository();
    writeFileSync(join(repository.worktree, "ahead.txt"), "ahead");
    git(repository.worktree, "add", "ahead.txt");
    git(repository.worktree, "commit", "-m", "local only");

    const result = runRelease(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("main must exactly match origin/main");
    expect(git(repository.worktree, "tag", "--list")).toBe("");
  });

  test("refuses an invalid manifest version", () => {
    const repository = createReleaseRepository();
    writeFileSync(
      join(repository.worktree, "manifest.json"),
      JSON.stringify({ version: "next" }),
    );
    git(repository.worktree, "add", "manifest.json");
    git(repository.worktree, "commit", "-m", "invalid version");
    git(repository.worktree, "push", "origin", "main");

    const result = runRelease(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manifest version must use x.y.z format");
    expect(git(repository.worktree, "tag", "--list")).toBe("");
  });

  test("refuses to reuse a local release tag", () => {
    const repository = createReleaseRepository();
    git(repository.worktree, "tag", "v0.1.0");

    const result = runRelease(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release tag v0.1.0 already exists");
    expect(readFileSync(repository.commandLog, "utf8")).not.toContain("mise");
  });

  test("refuses to reuse a remote release tag", () => {
    const repository = createReleaseRepository();
    git(repository.worktree, "tag", "v0.1.0");
    git(repository.worktree, "push", "origin", "v0.1.0");
    git(repository.worktree, "tag", "--delete", "v0.1.0");

    const result = runRelease(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Release tag v0.1.0 already exists on origin",
    );
    expect(readFileSync(repository.commandLog, "utf8")).not.toContain("mise");
  });

  test("waits for GitHub to create the tag-triggered workflow run", () => {
    const repository = createReleaseRepository();

    const result = runRelease(repository, { FAKE_DELAY_RUN: "1" });

    expect(result.status, result.stderr).toBe(0);
    const commandLog = readFileSync(repository.commandLog, "utf8");
    expect(commandLog.match(/gh run list/g)).toHaveLength(2);
    expect(commandLog).toContain("sleep 3");
    expect(commandLog).toContain("gh run watch 123 --exit-status");
  });

  test("checks GitHub authentication before creating the tag", () => {
    const repository = createReleaseRepository();

    const result = runRelease(repository, { FAKE_GH_AUTH_FAIL: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub CLI authentication is required");
    expect(git(repository.worktree, "tag", "--list")).toBe("");
    expect(readFileSync(repository.commandLog, "utf8")).not.toContain("mise");
  });
});
