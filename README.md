# Tab Stash ↔ Hister Bridge

Sidecar bridge connecting Firefox [Tab Stash](https://github.com/josh-berry/tab-stash) with the [Hister](https://github.com/asciimoo/hister) archival search engine. Stashed tabs are archived in Hister with [Defuddle](https://github.com/kepano/defuddle)-extracted text and HTML, and items tagged for mobile are pulled back into Tab Stash. The repository and pnpm package are named `tab-hister-bridge`.

> [!NOTE]
> Fully vibe coded slop with only high level supervision and QA, made to explore the Hister API, Tab Stash, Firefox AMO publishing, and satisfy my own needs. Provided as-is, not for production, expect breaking changes yadda yadda.

## What it does

### Archive on stash

The extension listens for bookmark events under the `Tab Stash` root folder. Each stashed page gets a label built from its folder path: `stash`, `stash/engineering`, or `stash/engineering/distributed-systems`. Before indexing, the bridge tries to read the rendered page from the active tab with `scripting` and falls back to a network request when the tab is unavailable. [Defuddle](https://github.com/kepano/defuddle) extracts the title, clean HTML, and plain text for Hister's full-text index. PDFs are uploaded through `/api/add_pdf`. Each entry carries `extractor: defuddle` and `extractor_version` metadata so later runs know how the content was produced.

### Label lifecycle

The bridge records the label a Hister entry had before it took over, and restores that label when the bookmark leaves Tab Stash or is removed. Duplicate URLs in the stash are counted, so the original label returns only after the last copy leaves. Moving or renaming stash folders updates the corresponding labels.

### Backfill

Existing stashes can be indexed in bulk from the options page or from the CLI. Both paths refresh entries with missing text, entries extracted by an older Defuddle version, and PDF URLs, then fix labels that no longer match the folder path. Details are in [Backfill](#backfill) below.

### Mobile ingestion

When enabled, a background alarm polls Hister for `label:<prefix>:mobile` every 5 minutes. New URLs are created under a `Mobile Inbox` folder inside Tab Stash, and processed entries are relabeled `<prefix>:synced`.

## Table of contents

1. [What it does](#what-it-does)
2. [Quickstart](#quickstart)
3. [Tasks](#tasks)
4. [Backfill](#backfill)
5. [Layout](#layout)
6. [CI](#ci)
7. [Configuration](#configuration)
8. [Notes and caveats](#notes-and-caveats)
9. [License](#license)

## Quickstart

### Prerequisites

- [mise](https://mise.jdx.dev/) installs Node.js and pnpm from `mise.toml` and `mise.lock`.
- [Docker](https://www.docker.com/) runs the local Hister daemon.
- [Firefox Desktop](https://www.mozilla.org/firefox/) 142+ or a compatible [Zen](https://zen-browser.app/) release loads the extension.
- [Dagger](https://dagger.io/) is required only for `mise run ci:dagger`.
- A Tab Stash checkout for `tabstash:install` and `tabstash:build`. It defaults to `../tab-stash`; override with the `TABSTASH_DIR` environment variable.

### Install dependencies

```bash
mise install
mise run bridge:install
mise run tabstash:install
```

`tabstash:install` and `mise run tabstash:build` prepare the Tab Stash checkout (`../tab-stash` by default, overridable with `TABSTASH_DIR`).

### Run Hister locally

```bash
mise run hister:up
```

This starts `ghcr.io/asciimoo/hister:latest` on `http://127.0.0.1:4433` and stores its data in `dev-data/` through a bind mount, so the archive survives container restarts.

```bash
mise run hister:logs   # follow logs
mise run hister:down   # stop the container
```

### Build and load the extension

```bash
mise run tabstash:build
mise run bridge:build
mise run dev:firefox
```

`mise run dev` starts Hister and builds the bridge in one command, then prints the `dev:firefox` command to launch an isolated browser profile with both extensions loaded. Its output looks like:

```text
=== Dev Environment Ready ===
1. Hister running at: http://localhost:4433
2. Bridge bundled in ./dist
To launch Firefox with the bridge: mise run dev:firefox
```

After `mise run dev:firefox`, the browser opens at `about:debugging#/runtime/this-firefox` with the bridge loaded, `dev-profile` keeps Tab Stash and its data across runs, and `http://127.0.0.1:4433` serves the Hister dashboard.

### Install from a release

Pushing a `v*.*.*` tag (matching `manifest.json`'s `version`) triggers the [Release workflow](.github/workflows/release.yml), which publishes to GitHub Releases:

- `tab-hister-bridge-<version>.xpi` — signed as an **unlisted** AMO add-on (requires the `AMO_API_KEY`/`AMO_API_SECRET` `release` environment secrets from the [AMO Developer Hub](https://addons.mozilla.org/developers/)). Opens and installs **permanently** in Firefox Desktop 142+.
- `tab-hister-bridge-<version>.zip` — unsigned build; loads only as a temporary add-on via `about:debugging` → **Load Temporary Add-on** (discarded on restart).
- `updates.json` — Firefox update manifest (only on signed releases); `manifest.json` points `browser_specific_settings.gecko.update_url` at the `releases/latest/download/updates.json` redirect, so Firefox picks up new versions **automatically** (daily update check) once a release with `update_url` in its manifest is installed.
- `SHA256SUMS.txt` — checksums for the artifacts.

The signing job is gated by the protected `release` environment and requires approval before it can access AMO credentials. Configure the credentials as environment secrets with `gh secret set --env release AMO_API_KEY` and `gh secret set --env release AMO_API_SECRET`. Production tag releases fail when signing is unavailable; manual dispatches remain the unsigned packaging path.

**AMO version immutability:** Mozilla's signing API refuses to sign the same add-on ID + version twice. A bad release cannot be re-signed under the same tag — bump `manifest.json`'s `version` and cut a new tag (`v0.1.0` → `v0.1.1`). Re-pushing an existing tag re-uploads assets to GitHub but the signing step will fail against AMO.

## Tasks

### Development

| Task                        | Description                                                                       |
| --------------------------- | --------------------------------------------------------------------------------- |
| `mise run hister:up`        | Start the local Hister container on port 4433                                     |
| `mise run hister:down`      | Stop the local Hister container                                                   |
| `mise run hister:logs`      | Follow Hister container logs                                                      |
| `mise run tabstash:install` | Install dependencies in the Tab Stash checkout (`$TABSTASH_DIR`)                  |
| `mise run tabstash:build`   | Build Tab Stash in the checkout (`$TABSTASH_DIR`)                                 |
| `mise run bridge:install`   | Install bridge dependencies with pnpm                                             |
| `mise run build`            | Bundle `dist/` with [tsup](https://tsup.egoist.dev/) (`bridge:build` is an alias) |
| `mise run test`             | Run [Vitest](https://vitest.dev/) unit tests                                      |
| `mise run dev`              | Start Hister and build the bridge                                                 |
| `mise run dev:firefox`      | Launch Zen or Firefox with both extensions loaded                                 |

### Quality gates

| Task                    | Description                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `mise run format`       | Write [Prettier](https://prettier.io/) formatting (`fmt` also works)                       |
| `mise run format-check` | Check formatting (`fmtcheck` also works)                                                   |
| `mise run lint:oxlint`  | Lint with [oxlint](https://oxc.rs/docs/guide/usage/linter.html), type-aware rules included |
| `mise run lint:fix`     | Auto-fix oxlint findings                                                                   |
| `mise run check`        | Type-check with tsc (`typecheck` also works)                                               |
| `mise run fix`          | Format and auto-fix lint findings                                                          |
| `mise run lint`         | format-check, oxlint, and typecheck together                                               |
| `mise run verify`       | `lint` plus unit tests, the pre-PR gate                                                    |

### CI and audits

| Task                        | Description                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `mise run ci`               | `verify`, audits, and build, all on the host                                                      |
| `mise run ci:dagger`        | The same checks in a locked Dagger container                                                      |
| `mise run ci:package`       | Build `web-ext-artifacts/tab-hister-bridge.zip` through Dagger                                    |
| `mise run actions:lint`     | Lint workflows with [actionlint](https://github.com/rhysd/actionlint)                             |
| `mise run actions:audit`    | Audit workflows with [zizmor](https://github.com/zizmorcore/zizmor), pedantic and without ignores |
| `mise run audit:prod`       | Check production dependencies for known vulnerabilities                                           |
| `mise run audit:all`        | Check all dependencies for known vulnerabilities                                                  |
| `mise run audit:signatures` | Verify registry signatures for installed packages                                                 |

## Backfill

The backfill scans every supported bookmark under `Tab Stash` and syncs each one with Hister. It reads the browser's `places.sqlite` through a [SQLite backup API](https://www.sqlite.org/c3ref/backup_finish.html) snapshot, so Firefox can keep running while it works.

### From the options page

Open `about:addons`, select **Tab Stash - Hister Bridge**, and open **Preferences**. The **Knowledge Pipeline & Backfill** card shows a **Sync & Backfill Stashes** button and reports progress while the scan runs in the background.

### From the CLI

```bash
pnpm run backfill -- --dry-run   # report what would change
pnpm run backfill -- --force     # re-extract every supported URL
```

The CLI reads the same configuration from environment variables:

| Variable        | Default                     | Purpose                       |
| --------------- | --------------------------- | ----------------------------- |
| `PLACES_SQLITE` | `dev-profile/places.sqlite` | Firefox profile database path |
| `HISTER_URL`    | `http://127.0.0.1:4433`     | Hister server URL             |
| `HISTER_TOKEN`  | empty                       | Optional Bearer token         |
| `TAG_PREFIX`    | `stash`                     | Label prefix                  |

## Layout

```text
.
├── manifest.json          # MV3 WebExtension manifest (Firefox Desktop 142+)
├── mise.toml              # Toolchain pins and task definitions
├── mise.lock              # Locked tool versions and checksums
├── package.json           # pnpm scripts (build, test, lint, format, backfill)
├── LICENSE                # MIT license
├── PRIVACY.md             # User-data handling policy
├── AMO_SOURCE_README.md   # Reproducible build instructions for AMO reviewers
├── src/                   # Background logic, options UI, Hister client, extractor
├── scripts/               # places.sqlite backfill CLI and SQLite snapshot helper
├── tests/                 # Vitest unit tests (happy-dom)
├── ci/                    # Dagger module: check and package pipelines
├── bin/mise               # Self-contained mise bootstrap used by the Dagger container
└── .github/workflows/     # Dagger checks, workflow policy, extension packaging
```

## CI

GitHub Actions runs three jobs on pull requests and pushes to `main`:

- **Project checks** runs `mise run ci:dagger`: format-check, oxlint, typecheck, tests, build, `web-ext lint`, and the audits inside a Dagger container. The container pins Node.js and pnpm from `mise.lock` and reuses cached mise and pnpm stores.
- **Workflow policy** runs actionlint and zizmor over `.github/workflows`.
- **Package extension** builds the extension zip with web-ext and uploads it as a run artifact.

The audits run with `pnpm audit --ignore-registry-errors`. Vulnerability findings fail the pipeline; npm registry outages do not.

A separate [Release workflow](.github/workflows/release.yml) runs on `v*.*.*` tags (and manually via `workflow_dispatch`): it re-runs the Dagger checks, verifies the tag matches `manifest.json`'s `version` and belongs to `main`, builds the zip, submits reviewer source code and signs an unlisted `.xpi` after approval from the protected `release` environment, validates every asset in a draft release, publishes it, and smoke-tests the public update channel. Packaging, signing, and publishing run in separate least-privilege jobs, so AMO credentials never share a job with GitHub release write access. Manual dispatches intentionally skip AMO signing and upload the unsigned build artifacts to the run instead of creating a release, so they do not consume an immutable AMO version. Note that Mozilla does not allow re-signing the same version: every release needs a fresh `manifest.json` version bump.

## Configuration

The options page (`about:addons` → **Tab Stash - Hister Bridge** → **Preferences**) holds:

- **Hister Server URL**: `http://127.0.0.1:4433` for local development.
- **Access Token**: optional Bearer token for protected Hister endpoints.
- **Default Tag Prefix**: defaults to `stash`.
- **Poll & sync mobile stashes**: checks for `label:stash:mobile` every 5 minutes.
- **Sync & Backfill Stashes**: runs the backfill described above.
- Quick links to search stashed tabs and open the Hister dashboard.

The toolbar popup opens this same page.

## Notes and caveats

- `web-ext lint` (run with `--self-hosted`, since the extension declares a custom `gecko.update_url` for GitHub Releases distribution) reports warnings CI does not treat as failures: `UNSAFE_VAR_ASSIGNMENT` findings inside the bundled Defuddle code. `strict_min_version` is `142.0` because `data_collection_permissions` requires Firefox 140+ on desktop and 142+ on Android; Firefox for Android is not enabled.
- The host extension carries `tabs`, `scripting`, and broad `http(s)` host permissions, which are needed to read rendered pages and fetch stashed URLs.
- Data handling is documented in the [privacy policy](PRIVACY.md).
- The mobile poll replaces the original `stash:mobile` label with `stash:synced` when the URL is imported.

## License

[MIT](LICENSE)
