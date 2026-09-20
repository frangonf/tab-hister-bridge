import { dag, Directory, File, func, object } from "@dagger.io/dagger";

type CheckStep = {
  name: string;
  command: string[];
};

const CHECK_STEPS: readonly CheckStep[] = [
  { name: "format-check", command: ["pnpm", "run", "format:check"] },
  { name: "oxlint", command: ["pnpm", "run", "lint"] },
  { name: "typecheck", command: ["pnpm", "run", "typecheck"] },
  { name: "test", command: ["pnpm", "run", "test"] },
  { name: "build", command: ["pnpm", "run", "build"] },
  {
    name: "web-ext-lint",
    command: [
      "pnpm",
      "exec",
      "web-ext",
      "lint",
      "--source-dir",
      ".",
      // The extension is self-distributed (unlisted, GitHub Releases) and
      // declares a custom gecko.update_url, which is only valid when
      // self-hosted.
      "--self-hosted",
      "--ignore-files",
      "dev-profile/**",
      "dev-data/**",
    ],
  },
  // Audit findings fail the pipeline; registry outages do not.
  {
    name: "audit-prod",
    command: [
      "pnpm",
      "audit",
      "--prod",
      "--audit-level",
      "high",
      "--ignore-registry-errors",
    ],
  },
  {
    name: "audit-all",
    command: [
      "pnpm",
      "audit",
      "--audit-level",
      "high",
      "--ignore-registry-errors",
    ],
  },
  { name: "audit-signatures", command: ["pnpm", "audit", "signatures"] },
];

// Exclude development and reviewer scaffolding while retaining the manifest,
// generated bundles, icons, options page, license, and privacy policy.
const PACKAGE_IGNORES = [
  "dev-profile",
  "dev-profile/**",
  "dev-data",
  "dev-data/**",
  "tests",
  "tests/**",
  "scripts",
  "scripts/**",
  "ci",
  "ci/**",
  ".github",
  ".github/**",
  "node_modules",
  "node_modules/**",
  "web-ext-artifacts",
  "web-ext-artifacts/**",
  ".mise",
  ".mise/**",
  "bin",
  "bin/**",
  "README.md",
  "AMO_SOURCE_README.md",
  "mise.toml",
  "mise.lock",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsup.config.ts",
  "vitest.config.ts",
  ".oxlintrc.json",
  ".prettierignore",
  ".gitignore",
];

const SOURCE_EXCLUDES = [
  ".git",
  ".mise",
  "node_modules",
  "dist",
  "dev-profile",
  "dev-data",
  "web-ext-artifacts",
  "ci/node_modules",
  "ci/sdk",
];

// AMO names the signed artifact after the add-on and version
// (e.g. tab_stash_hister_bridge-0.1.0.xpi); normalize it so release
// automation can export it under a stable name.
const SIGNED_ARTIFACT = "tab-hister-bridge-signed.xpi";
const SOURCE_ARTIFACT = "tab-hister-bridge-source.zip";
const SOURCE_ARCHIVE_IGNORES = [
  ".git/*",
  ".mise/*",
  "node_modules/*",
  "dist/*",
  "dev-profile/*",
  "dev-data/*",
  "web-ext-artifacts/*",
  "ci/node_modules/*",
  "ci/sdk/*",
];

@object()
export class Ci {
  private nodeBase(source: Directory) {
    const miseBootstrap = "/app/bin/mise";
    const miseCache = dag.cacheVolume("tab-hister-bridge-mise-data");
    const pnpmCache = dag.cacheVolume("tab-hister-bridge-pnpm-store");

    let container = dag
      .container()
      .from("debian:bookworm-slim")
      .withEnvVariable("DEBIAN_FRONTEND", "noninteractive")
      .withExec(["apt-get", "update", "-qq"])
      .withExec([
        "apt-get",
        "install",
        "-y",
        "-qq",
        "--no-install-recommends",
        "bash",
        "ca-certificates",
        "curl",
        "git",
        "libatomic1",
        "libsqlite3-0",
        "zip",
      ])
      .withExec(["sh", "-c", "rm -rf /var/lib/apt/lists/*"])
      .withExec(["mkdir", "-p", "/app"])
      .withWorkdir("/app")
      // Self-contained mise inside the project tree (mise CI convention).
      // The bootstrap script sets MISE_DATA_DIR=/app/.mise and a versioned
      // MISE_INSTALL_PATH inside it, then runs the mise binary directly.
      // We also set the same env vars in Dagger so they persist across
      // withExec calls (env vars set inside the bootstrap do not persist).
      // MISE_LOCKED=1 keeps the toolchain pinned to mise.lock.
      .withFile("/app/bin/mise", source.file("bin/mise"))
      .withFile("/app/mise.toml", source.file("mise.toml"))
      .withFile("/app/mise.lock", source.file("mise.lock"))
      .withEnvVariable("MISE_DATA_DIR", "/app/.mise")
      .withEnvVariable("MISE_CONFIG_DIR", "/app/.mise/config")
      .withEnvVariable("MISE_CACHE_DIR", "/app/.mise/cache")
      .withEnvVariable("MISE_STATE_DIR", "/app/.mise/state")
      .withEnvVariable("MISE_YES", "1")
      .withEnvVariable("MISE_AUTO_INSTALL", "false")
      .withEnvVariable("MISE_TRUSTED_CONFIG_PATHS", "/app")
      .withEnvVariable("MISE_LOCKED", "1")
      .withMountedCache("/app/.mise", miseCache)
      .withMountedCache("/pnpm-store", pnpmCache)
      .withExec([miseBootstrap, "install", "node", "pnpm"])
      .withEnvVariable(
        "PATH",
        "/app/.mise/shims:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
      );

    for (const manifest of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]) {
      container = container.withFile(`/app/${manifest}`, source.file(manifest));
    }

    return container
      .withExec(["pnpm", "config", "set", "store-dir", "/pnpm-store"])
      .withExec(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"])
      .withDirectory("/app", source, { exclude: SOURCE_EXCLUDES });
  }

  private async execute(
    source: Directory,
    steps: readonly CheckStep[],
  ): Promise<string> {
    let container = this.nodeBase(source);
    const results: string[] = [];

    for (const step of steps) {
      try {
        container = container.withExec(step.command);
        const output = await container.stdout();
        if (output.trim()) {
          results.push(`[${step.name}] ${output}`);
        }
      } catch (error) {
        throw new Error(`${step.name} failed: ${String(error)}`, {
          cause: error,
        });
      }
    }

    return results.join("\n");
  }

  @func()
  async check(source: Directory): Promise<string> {
    return this.execute(source, CHECK_STEPS);
  }

  @func()
  async package(source: Directory): Promise<File> {
    const build = this.nodeBase(source).withExec(["pnpm", "run", "build"]);
    const container = build.withExec([
      "pnpm",
      "exec",
      "web-ext",
      "build",
      "--source-dir",
      ".",
      "--artifacts-dir",
      "web-ext-artifacts",
      "--filename",
      "tab-hister-bridge.zip",
      "--overwrite-dest",
      "--ignore-files",
      ...PACKAGE_IGNORES,
    ]);
    return container.file("/app/web-ext-artifacts/tab-hister-bridge.zip");
  }

  // Signs the extension as an unlisted add-on via the Mozilla Add-ons API,
  // producing a .xpi that Firefox installs permanently when downloaded from
  // a GitHub Release. Credentials are injected as Dagger secrets and never
  // appear in container env logs.
  @func()
  sign(source: Directory, apiKey: Secret, apiSecret: Secret): File {
    const build = this.nodeBase(source)
      .withExec(["pnpm", "run", "build"])
      .withExec(["mkdir", "-p", "web-ext-artifacts"])
      .withExec([
        "zip",
        "-q",
        "-r",
        `web-ext-artifacts/${SOURCE_ARTIFACT}`,
        ".",
        "-x",
        ...SOURCE_ARCHIVE_IGNORES,
      ]);
    const container = build
      .withSecretVariable("WEB_EXT_API_KEY", apiKey)
      .withSecretVariable("WEB_EXT_API_SECRET", apiSecret)
      .withExec([
        "pnpm",
        "exec",
        "web-ext",
        "sign",
        "--source-dir",
        ".",
        "--artifacts-dir",
        "web-ext-artifacts",
        "--channel",
        "unlisted",
        "--timeout",
        "900000",
        "--upload-source-code",
        `web-ext-artifacts/${SOURCE_ARTIFACT}`,
        "--ignore-files",
        ...PACKAGE_IGNORES,
      ])
      .withoutSecretVariable("WEB_EXT_API_KEY")
      .withoutSecretVariable("WEB_EXT_API_SECRET")
      .withExec([
        "sh",
        "-c",
        `mv web-ext-artifacts/*.xpi web-ext-artifacts/${SIGNED_ARTIFACT}`,
      ]);
    return container.file(`/app/web-ext-artifacts/${SIGNED_ARTIFACT}`);
  }
}
