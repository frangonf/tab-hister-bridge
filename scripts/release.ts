import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface WorkflowRun {
  databaseId: number;
  headSha: string;
  url: string;
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
  if (
    typeof manifest.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)
  ) {
    throw new Error("The manifest version must use x.y.z format");
  }
  const tag = `v${manifest.version}`;
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
  const remoteTagStatus = commandStatus("git", [
    "ls-remote",
    "--exit-code",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ]);
  if (remoteTagStatus === 0) {
    throw new Error(`Release tag ${tag} already exists on origin`);
  }
  if (remoteTagStatus !== 2) {
    throw new Error(`Could not check release tag ${tag} on origin`);
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
