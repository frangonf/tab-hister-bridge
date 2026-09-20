import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface WorkflowRun {
  databaseId: number;
  headSha: string;
  url: string;
}

type BumpType = "patch" | "minor" | "major";
type Version = [major: number, minor: number, patch: number];

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value: unknown): Version | undefined {
  if (typeof value !== "string") return undefined;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return undefined;
  const version = match.slice(1).map(Number) as Version;
  return version.every(Number.isSafeInteger) ? version : undefined;
}

function formatVersion([major, minor, patch]: Version): string {
  return `${major}.${minor}.${patch}`;
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function incrementVersion(
  [major, minor, patch]: Version,
  bump: BumpType,
): Version {
  if (bump === "major") return [major + 1, 0, 0];
  if (bump === "minor") return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

function run(
  command: string,
  args: string[],
  options: { capture?: boolean; allowFailure?: boolean } = {},
): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function commandStatus(command: string, args: string[]): number | null {
  return spawnSync(command, args, { stdio: "ignore" }).status;
}

function main(): void {
  const args = process.argv.slice(2);
  const bump = args[0];
  if (
    args.length !== 1 ||
    (bump !== "patch" && bump !== "minor" && bump !== "major")
  ) {
    throw new Error("Bump type must be patch, minor, or major");
  }

  const branch = run("git", ["branch", "--show-current"], { capture: true });
  if (branch !== "main") {
    throw new Error("Releases must run from the main branch");
  }
  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (status) {
    throw new Error("The working tree must be clean before releasing");
  }

  run("git", [
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    "main:refs/remotes/origin/main",
  ]);
  const head = run("git", ["rev-parse", "HEAD"], { capture: true });
  const remoteHead = run("git", ["rev-parse", "origin/main"], {
    capture: true,
  });
  if (head !== remoteHead) {
    throw new Error("Local main must exactly match origin/main");
  }

  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
    version?: unknown;
  };
  const version = parseVersion(manifest.version);
  if (!version) {
    throw new Error("The manifest version must use x.y.z format");
  }
  const versionName = formatVersion(version);
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    version?: unknown;
  };
  if (packageJson.version !== versionName) {
    throw new Error("package.json version must match manifest.json");
  }

  const tag = `v${versionName}`;
  if (
    commandStatus("git", [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/tags/${tag}`,
    ]) === 0
  ) {
    throw new Error(`Release tag ${tag} already exists locally`);
  }
  const remoteTags = run(
    "git",
    ["ls-remote", "--tags", "origin", "refs/tags/v*"],
    { capture: true },
  );
  const releasedVersions = new Map<string, Version>();
  for (const line of remoteTags.split("\n")) {
    const ref = line.trim().split(/\s+/)[1];
    const match = /^refs\/tags\/v([^^]+)(?:\^\{\})?$/.exec(ref ?? "");
    const releasedVersion = parseVersion(match?.[1]);
    if (releasedVersion) {
      releasedVersions.set(formatVersion(releasedVersion), releasedVersion);
    }
  }
  if (releasedVersions.has(versionName)) {
    throw new Error(`Release tag ${tag} already exists on origin`);
  }

  const previousVersion = [...releasedVersions.values()]
    .sort(compareVersions)
    .at(-1) ?? [0, 0, 0];
  const expectedVersion = incrementVersion(previousVersion, bump);
  if (compareVersions(version, expectedVersion) !== 0) {
    throw new Error(
      `A ${bump} release after v${formatVersion(previousVersion)} must use ${formatVersion(expectedVersion)}, but manifest.json uses ${versionName}`,
    );
  }

  if (commandStatus("gh", ["auth", "status"]) !== 0) {
    throw new Error(
      "GitHub CLI authentication is required; run `gh auth login`",
    );
  }

  console.log(`Verifying ${tag}...`);
  run("mise", ["run", "verify"]);

  run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
  run("git", ["push", "origin", tag]);

  let workflowRun: WorkflowRun | undefined;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const runs = JSON.parse(
      run(
        "gh",
        [
          "run",
          "list",
          "--workflow",
          "release.yml",
          "--event",
          "push",
          "--branch",
          tag,
          "--limit",
          "5",
          "--json",
          "databaseId,url,headSha",
        ],
        { capture: true },
      ),
    ) as WorkflowRun[];
    workflowRun = runs.find((candidate) => candidate.headSha === head);
    if (workflowRun) break;
    if (attempt < 20) {
      console.log(
        `Waiting for GitHub to start the release workflow (${attempt}/20)...`,
      );
      run("sleep", ["3"]);
    }
  }
  if (!workflowRun) {
    throw new Error(`Could not find the release workflow run for ${tag}`);
  }

  console.log(`Release workflow: ${workflowRun.url}`);
  console.log("Approve the protected release environment when prompted.");
  run("gh", ["run", "view", String(workflowRun.databaseId), "--web"], {
    allowFailure: true,
  });
  run("gh", ["run", "watch", String(workflowRun.databaseId), "--exit-status"]);
}

try {
  main();
} catch (error) {
  console.error(`Release failed: ${String(error)}`);
  process.exitCode = 1;
}
