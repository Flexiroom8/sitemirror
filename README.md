# Site Mirror

Site Mirror is an authorized website archiving tool. It crawls a site within
its own origin, downloads pages and selected assets, rewrites links for
offline browsing, and produces a downloadable ZIP archive.

Only mirror websites you own or have explicit permission to archive. Site
Mirror does not bypass authentication, Cloudflare, anti-bot controls, or
other access restrictions.

## Features

- Same-origin crawling with configurable page and depth limits
- Robots.txt support and configurable request throttling
- SSRF protection, DNS-rebinding defense, and request-level address checks
- Path prefixes and exclusion rules for precise crawl scope
- Optional asset downloads with per-asset and total archive size limits
- Live progress, cancellation, job history, and ZIP downloads
- Offline link rewriting for archived pages
- Bounded concurrency, time limits, automatic cleanup, and graceful shutdown
- Puppeteer/Chrome preparation during API builds for reliable deployment

## Quick start

### Requirements

- Node.js 24+
- pnpm

The mirror feature does not require a database.

### Install

```bash
pnpm install
```

### Run locally

Start the API and frontend in separate terminals:

```bash
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/site-mirror run dev
```

The API uses port `8080` and the frontend uses port `19316` in the workspace
configuration. Replit workflows configure these ports automatically.

### Verify and build

```bash
pnpm run typecheck
pnpm run verify
pnpm run build
```

`pnpm run verify` installs the locked dependencies, typechecks the workspace,
builds the packages, and smoke-tests the API health endpoint.

## Configuration

The API requires `PORT` when started directly. The Replit workflow and
deployment configuration provide it automatically.

Optional mirror settings:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `MIRROR_MAX_CONCURRENT_JOBS` | `3` | Maximum simultaneous mirror jobs |
| `MIRROR_ASSET_CONCURRENCY` | `4` | Parallel asset downloads per job |
| `MIRROR_DEFAULT_TIMEOUT_MS` | `900000` | Default crawl time limit |
| `MIRROR_DEFAULT_MAX_TOTAL_BYTES` | `524288000` | Default total archive limit |
| `MIRROR_MAX_ASSET_BYTES` | `52428800` | Maximum individual asset size |
| `MIRROR_JOB_RETENTION_MS` | `21600000` | Finished-job retention period |
| `MIRROR_RATE_LIMIT_WINDOW_MS` | `60000` | Job creation rate-limit window |
| `MIRROR_RATE_LIMIT_MAX` | `10` | Jobs allowed per rate-limit window |

## API endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/healthz` | Health check |
| `POST` | `/api/mirror-jobs` | Start a mirror job |
| `GET` | `/api/mirror-jobs` | List recent jobs |
| `GET` | `/api/mirror-jobs/:id` | Read job progress |
| `POST` | `/api/mirror-jobs/:id/cancel` | Cancel a running job |
| `GET` | `/api/mirror-jobs/:id/download` | Download a completed ZIP |

Example job request:

```json
{
  "url": "https://example.com/",
  "maxPages": 100,
  "maxDepth": 3,
  "requestDelayMs": 250,
  "respectRobotsTxt": true,
  "includeAssets": true,
  "pathPrefix": "/",
  "excludePaths": ["/admin", "/api"],
  "timeoutMs": 900000,
  "maxTotalBytes": 524288000
}
```

## Project structure

```text
artifacts/api-server/       Express API and crawler
artifacts/site-mirror/      React interface
artifacts/mockup-sandbox/   Component preview server
lib/api-spec/               OpenAPI source of truth
lib/api-zod/                Generated request validation
lib/api-client-react/       Generated React Query hooks
scripts/                    Workspace verification utilities
```

## Architecture notes

- Jobs are process-local and temporary; restarting the API clears active jobs
  and generated archives.
- The API contract is OpenAPI-first. Regenerate or update the generated
  client and Zod files when changing the API specification.
- Production deployment is configured as an autoscale web application. The
  API build prepares Chrome before the published process starts.