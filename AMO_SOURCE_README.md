# AMO reviewer build instructions

This archive contains the source used to build Tab Stash - Hister Bridge.

## Build environment

- Linux (the release build runs in `debian:bookworm-slim`)
- Node.js 26
- pnpm 12

Exact Node.js and pnpm versions are pinned in `mise.toml` and `mise.lock`. JavaScript dependencies are pinned in `pnpm-lock.yaml`.

## Build

From the archive root, reproduce the complete unsigned extension package with:

```bash
mise install --locked
mise exec -- dagger call -m ci package --source=. export --path=web-ext-artifacts/tab-hister-bridge.zip
```

The Dagger module installs dependencies with `pnpm install --frozen-lockfile`, runs `pnpm run build`, and invokes `web-ext build` with the same exclusions used for AMO signing. The generated JavaScript is written to `dist/`, and the complete extension package is exported to `web-ext-artifacts/tab-hister-bridge.zip`.

To build only the generated JavaScript without Dagger:

```bash
pnpm install --frozen-lockfile
pnpm run build
```
