# Tab Stash ↔ Hister Bridge

A WebExtension sidecar and local developer orchestration workspace connecting [Firefox Tab Stash](https://github.com/josh-berry/tab-stash) with the [Hister](https://github.com/asciimoo/hister) personal search and archival engine.

---

## Overview & Architecture

When researching and browsing across desktop and mobile, tabs are often stashed in Firefox using **Tab Stash**. Tab Stash persists stashes as native Firefox bookmarks under a dedicated `Tab Stash` bookmark folder.

`tab-hister-bridge` provides:

1. **Automated Hister Archiving**: Intercepts tab stashes as they are created in Firefox bookmarks and mirrors them to Hister's REST API (`/api/add`), archiving full-text page content, metadata, and hierarchical labels (e.g. `stash`, `stash/engineering`, `distributed-systems`).
2. **Mobile Stash Ingestion**: Periodically queries Hister for items tagged with `stash:mobile` (captured via mobile share sheets or browser extensions) and inserts them directly into Desktop Tab Stash.
3. **Multi-Repo Dev Orchestration**: Acts as the central runner and tooling hub for developing against upstream forks:
   - Clean fork of [`frangonf/tab-stash`](https://github.com/frangonf/tab-stash)
   - Clean fork of [`frangonf/hister`](https://github.com/frangonf/hister)
   - Orchestrator [`frangonf/tab-hister-bridge`](https://github.com/frangonf/tab-hister-bridge)

By housing all developer tasks, Docker runners, and build commands in `tab-hister-bridge/mise.toml`, both upstream forks remain 100% untainted and ready to submit upstream pull requests (`tab-stash#653`, `hister#500/#626`).

---

## Directory Structure

```
/Users/fran/Documents/Projects/github.com/frangonf/
├── hister/              # Upstream fork (Go backend, Svelte/HTMX UI)
├── tab-stash/           # Upstream fork (React/TypeScript Firefox extension)
└── tab-hister-bridge/   # This repository: sidecar extension & mise orchestrator
    ├── manifest.json    # MV3 WebExtension manifest
    ├── mise.toml        # Mise task orchestrator
    ├── package.json     # Node/TypeScript/Vitest/web-ext dependencies
    ├── src/             # Extension background & options UI source
    └── tests/           # Unit tests
```

---

## Quickstart

### 1. Prerequisites

- [Mise](https://mise.jdx.dev/) (`mise`)
- [Node.js](https://nodejs.org/) & [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/) (for running local Hister daemon)
- [Firefox](https://www.mozilla.org/firefox/)

### 2. Install Dependencies

```bash
mise run bridge:install
mise run tabstash:install
```

### 3. Start Local Hister Service

Spins up a local Hister container on `http://127.0.0.1:4433` with persistent volume `hister-dev-data`:

```bash
mise run hister:up
```

To view logs or stop:

```bash
mise run hister:logs
mise run hister:down
```

### 4. Build Extensions & Launch Firefox

Build both Tab Stash and the Bridge, then launch an isolated Firefox development instance with both extensions loaded:

```bash
mise run dev
```

Or step-by-step:

```bash
mise run tabstash:build
mise run bridge:build
mise run dev:firefox
```

---

## Available Mise Tasks

| Task                        | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `mise run hister:up`        | Launch local Hister container at `http://127.0.0.1:4433` |
| `mise run hister:down`      | Stop local Hister container                              |
| `mise run hister:logs`      | Follow Hister container logs                             |
| `mise run tabstash:install` | Run `pnpm install` inside `../tab-stash`                 |
| `mise run tabstash:build`   | Build Tab Stash inside `../tab-stash`                    |
| `mise run bridge:install`   | Run `pnpm install` inside this repo                      |
| `mise run bridge:build`     | Compile TypeScript into `dist/` with `tsup`              |
| `mise run test`             | Run Vitest unit tests                                    |
| `mise run dev:firefox`      | Launch Zen/Firefox with both extensions loaded           |
| `mise run dev`              | Full local setup (`hister:up` + builds + `dev:firefox`)  |

---

## Configuration

In Firefox, navigate to `about:addons` -> **Tab Stash - Hister Bridge** -> **Preferences**:

- **Hister Server URL**: `http://127.0.0.1:4433` (local dev) or `https://hister.homelab.frangonf.com` (homelab)
- **Access Token**: Optional Bearer token for protected Hister endpoints.
- **Default Tag Prefix**: Default `stash`.
- **Poll & sync mobile stashes**: When enabled, runs every 5 minutes checking for `label:stash:mobile`.

---

## License

MIT
