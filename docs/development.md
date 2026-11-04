# Development

[Documentation](README.md) · **English** · [한국어](development.ko.md)

This guide is for contributors building Orrery from source. For installation and everyday use, start with the [product README](../README.md).

## Prerequisites

Use Node.js 24 or newer and npm. The desktop packaging dependencies require at least Node.js 22.12. An AWS profile with appropriate read permissions is needed for real resource discovery; automated tests use fixtures.

## Local development

```bash
git clone https://github.com/jjsslee/orrery.git
cd orrery
npm ci
npm run dev
```

Open the local access file printed by the server: `.orrery-cache/private/open-<API-port>.html`. Choose the development page from that file. Opening the bare web URL does not authenticate API calls. The default API port is 4820 and the Vite port is 5173; Vite does not silently move to a different port.

If a desktop build already occupies the API port:

```bash
ORRERY_PORT=4821 npm run dev
```

For the built web interface:

```bash
npm run build
npm start
```

Reopen the access file after every server restart: tokens rotate. Never publish, commit, or share that file or the private cache directory.

## Configuration

Source runs load the repository's gitignored `.env`; existing environment variables take precedence. Packaged desktop builds do not read `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `ORRERY_PORT` | `4820` | Local API port; the generic `PORT` variable is not used |
| `ORRERY_DEFAULT_PROFILE` | `AWS_PROFILE`, then `default` | Initial profile when no saved selection exists |
| `AWS_PROFILE` | — | Fallback AWS profile |
| `ORRERY_GRAPH_TTL_MS` | `600000` | Configuration cache lifetime |
| `ORRERY_METRICS_TTL_MS` | `60000` | Metric cache lifetime |
| `LOG_LEVEL` | `info` in source, `warn` packaged | Server log level |

See [`.env.example`](../.env.example). Configuration, credentials, cache entries, and local access files belong outside version control. Current graph snapshots and relationship history use `graph-v9` cache keys.

## Checks and packaging

```bash
npm run typecheck
npm test
npm run test:electron -w desktop
npm run package
```

There is no separate lint command. Tests cover the server, web interface, and desktop updater without making live AWS calls. Platform-specific native helper tests run on their supported OS.

Packaging currently runs on macOS. To build a single target:

```bash
npm run package -- macos-arm64
npm run package -- macos-x64
npm run package -- windows-x64
```

`scripts/package.mjs` bundles the server and Electron main process, packages the web build, writes updater metadata, applies macOS ad-hoc signatures, and produces the three ZIPs in `release/`. The local Mac's `Orrery.app` is retained for local use. Build intermediates live in `release/.work/`.

The root `package.json` version must match the release tag and each package's `orrery-update.json`. Build all assets before publishing a stable release. See the [release and recovery runbook](self-update.md) (Korean) for the exact transaction and rollback procedure.

## Repository map

| Directory | Responsibility |
|---|---|
| `shared/` | Graph, resource, monitoring, and API types |
| `server/` | Loopback API, AWS collectors, read-only guard, caches, metrics |
| `web/` | React interface, graph layout, resource inspection, monitoring |
| `desktop/` | Electron app lifecycle, permissions, updates and recovery |
| `scripts/` | Packaging, icons, opt-in verification tools |
| `docs/` | Product guides, contributor guides, release runbooks, dated records |

For collector and security details, see [architecture](architecture.ko.md) (Korean) and [security boundaries](security.md). When adding AWS operations, update the explicit service/command allowlist and its tests; preserve IAM and renderer isolation boundaries.

## Live verification tools

`scripts/verify-cloudwatch-monitoring.ts` defaults to a zero-call dry run and uses fictional example identifiers. Review its profile, region, functions, account check, period, and request limits before any separately authorized live run. Historical approvals in documents do not authorize new AWS calls.

## Documentation and reports

Keep product-facing READMEs in English and Korean aligned. Development instructions and verification details belong under `docs/`. Use fictional resource names and account IDs in public examples. Do not attach credentials, login URLs, raw account inventories, or real infrastructure screenshots to public issues.

There is currently no project-level `LICENSE` file. Bundled third-party font notices remain alongside their assets in `web/public/fonts/`.
