# Site Mirror

Site Mirror creates downloadable, same-origin website archives for sites the user owns or has explicit permission to copy. Mirrored pages are relinked to point at each other locally, so a completed archive is actually browsable offline, not just a folder of individually-correct files.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only; the mirror feature itself doesn't use the DB — see Architecture decisions)
- Required env: `DATABASE_URL` — Postgres connection string (required by the workspace template; not read by the mirror code path)

### Optional tuning env vars (all have sane defaults)

- `MIRROR_MAX_CONCURRENT_JOBS` — how many crawls run at once (default 3); extra jobs wait in a queue
- `MIRROR_ASSET_CONCURRENCY` — parallel asset downloads per job (default 4)
- `MIRROR_DEFAULT_TIMEOUT_MS` / `MIRROR_MAX_TIMEOUT_MS` — per-job wall-clock limit, default and ceiling (15 min / 60 min)
- `MIRROR_DEFAULT_MAX_TOTAL_BYTES` / `MIRROR_HARD_MAX_TOTAL_BYTES` — per-job archive size cap, default and ceiling (500 MB / 2 GB)
- `MIRROR_MAX_ASSET_BYTES` — skip any single asset larger than this (default 50 MB)
- `MIRROR_JOB_RETENTION_MS` — how long finished jobs (and their temp files) are kept before a periodic sweep clears them (default 6 hours)
- `MIRROR_RATE_LIMIT_WINDOW_MS` / `MIRROR_RATE_LIMIT_MAX` — rate limit on starting new jobs (default 10 per 60s)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, helmet, express-rate-limit
- DB: PostgreSQL + Drizzle ORM (provisioned by the template; unused by the mirror feature — see below)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/site-mirror/` — React interface for creating, monitoring, and browsing the history of mirror jobs
  - `src/pages/mirror-home.tsx` — new mirror form
  - `src/pages/mirror-job.tsx` — live job monitor and download
  - `src/pages/mirror-history.tsx` — recent job list
  - `src/lib/mirror-format.ts` — shared byte/date formatting helpers used by all three pages
- `artifacts/api-server/src/lib/mirror-jobs.ts` — crawl, progress, cancellation, offline link rewriting, and ZIP archive service
- `artifacts/api-server/src/routes/mirror.ts` — mirror job API routes (create, get, list, cancel, download)
- `artifacts/api-server/src/middlewares/rate-limit.ts` — rate limiter for job creation
- `lib/api-spec/openapi.yaml` — source of truth for the mirror API contract
- `lib/api-client-react/` and `lib/api-zod/` — generated client hooks and validation schemas

## Architecture decisions

- Crawls are same-origin only and deliberately do not attempt login, anti-bot, or protected-content bypasses.
- Jobs are kept in memory and written to a temporary directory for the current server process; ZIPs are generated on demand. This was a deliberate choice over DB persistence to keep the feature simple and avoid storing crawled third-party content durably; a retention sweep clears finished jobs' memory and disk after `MIRROR_JOB_RETENTION_MS`.
- Robots-aware crawling (Disallow/Allow with wildcards, Crawl-delay) and a configurable request delay are enabled by default.
- SSRF protection is defense-in-depth, not a single check: the initial URL is DNS-resolved and rejected if private/local at job creation, and every request the headless browser makes during the crawl is re-validated against the same rules via Puppeteer request interception. This closes the DNS-rebinding gap a single up-front check would leave open.
- A same-origin URL can still 30x redirect off-origin server-side; the final response URL is re-checked against scope before a page is saved.
- Navigation blocks image/media/font/stylesheet loads — faster crawls, same result.
- A bounded number of jobs run concurrently (`MIRROR_MAX_CONCURRENT_JOBS`); more requests queue rather than each launching its own Chromium instance.
- Per-job wall-clock timeout and total-byte cap stop a crawl of an unexpectedly large or slow site; a job that hits either still completes with whatever it collected, noted in its message.

## Product

Users can configure a permitted archive with advanced controls for depth, path scope, excludes, time limit, and size cap, watch live crawl progress, stop a running job, download a completed ZIP mirror that browses correctly offline, and revisit past jobs from the history page.

## Gotchas

- Run API codegen after changing `lib/api-spec/openapi.yaml`. The generated files under `lib/api-zod/src/generated/` and `lib/api-client-react/src/generated/` were hand-edited to match the current spec.
- Mirror jobs are process-local and temporary; a restart clears active jobs and archives. `MIRROR_JOB_RETENTION_MS` also clears them proactively even without a restart.
- Offline link rewriting is attribute-level regex (`href`/`src`/`poster`, plus `srcset` for discovery), not a full HTML/CSS parser — links inside inline `<style>` blocks or external CSS files' `url(...)` references are not rewritten.
- `puppeteer` needs Chromium available at runtime; `ensure-browser.mjs` (run via `predev`) handles that for local/dev use.