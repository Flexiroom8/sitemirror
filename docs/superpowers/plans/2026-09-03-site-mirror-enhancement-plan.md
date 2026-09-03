# Site Mirror enhancement implementation plan

**Design:** `docs/superpowers/specs/2026-09-03-site-mirror-enhancement-design.md`  
**Order:** Stage 1 correctness → Stage 2 reliability → Stage 3 product experience

## Scope and constraints

- Preserve the existing API routes, same-origin boundary, robots policy, public-URL validation, request-level SSRF protection, no-auth-bypass policy, autoscale deployment target, MIT metadata, and default/max page limits.
- Keep the public API compatibility layer in `artifacts/api-server/src/routes/mirror.ts`.
- Use focused modules instead of extending the current 985-line `mirror-jobs.ts` indefinitely.
- Use the existing Drizzle/Postgres package for durable job metadata and work state. Use a storage adapter so local development can use temporary files while production can use durable archive storage.
- Do not publish until the complete verification suite and a representative multi-page crawl pass.

## Task 1 — establish domain contracts and test fixtures

**Depends on:** none  
**Files to add/change:**

- `artifacts/api-server/src/lib/mirror-types.ts`
- `artifacts/api-server/src/lib/mirror-url.ts`
- `artifacts/api-server/src/lib/mirror-outcomes.ts`
- `artifacts/api-server/src/lib/mirror-fixtures/*`
- API test configuration/package scripts as needed

**Work:**

1. Define the canonical job, crawl-item, response metadata, progress, report, and archive manifest types.
2. Define URL identity normalization: preserve query strings, remove fragments, normalize safe forms, and retain original source URLs.
3. Define explicit terminal and retryable outcome codes.
4. Add a local fixture server or fixture handlers covering linked pages, non-2xx HTML, redirects, SPA-delayed links, assets, robots exclusions, slow responses, and transient failures.
5. Add unit tests for URL identity, scope decisions, response classification, outcome transitions, and deterministic archive paths.

**Verification:** focused unit tests and TypeScript typecheck pass before crawler behavior is changed.

## Task 2 — replace the lossy crawl loop with an auditable crawl engine

**Depends on:** Task 1  
**Files to add/change:**

- `artifacts/api-server/src/lib/mirror-crawler.ts`
- `artifacts/api-server/src/lib/mirror-discovery.ts`
- `artifacts/api-server/src/lib/mirror-fetch.ts`
- `artifacts/api-server/src/lib/mirror-policy.ts`
- `artifacts/api-server/src/lib/mirror-jobs.ts`

**Work:**

1. Extract URL policy, robots, redirect validation, request interception, and browser setup from `mirror-jobs.ts` without weakening existing checks.
2. Replace `seen`/`queue` bookkeeping with durable-ready work-item transitions: discovered → queued → fetching → saved/skipped/failed.
3. Ensure every eligible URL is evaluated within page/depth/scope/robots/byte/time limits.
4. Save HTML/XHTML documents regardless of final HTTP status, including 404/410, while recording status and content type.
5. Treat non-HTML responses as assets only when eligible; record unsupported, oversized, blocked, and failed resources.
6. Revalidate every redirect hop and final URL against origin, public DNS, path scope, and robots rules.
7. Discover anchors, resource attributes, `srcset`, CSS/resource references where available, sitemap entries when enabled, and links from the settled browser DOM.
8. Support client-rendered history routes with a bounded settle strategy and make fragment identity behavior explicit.
9. Add bounded retries for transient failures and never silently discard a work item.
10. Preserve cancellation, timeout, delay, concurrency, and total-byte behavior.

**Verification:** fixture crawl saves all eligible pages/assets, preserves non-2xx HTML, records all skipped/failed URLs, rejects unsafe redirects, and reproduces/fixes the previously observed real-world multi-page failure.

## Task 3 — make rewriting and packaging complete and deterministic

**Depends on:** Task 2  
**Files to add/change:**

- `artifacts/api-server/src/lib/mirror-rewriter.ts`
- `artifacts/api-server/src/lib/mirror-archive.ts`
- `artifacts/api-server/src/lib/mirror-jobs.ts`

**Work:**

1. Build a complete requested/final/alias URL map only after saving decisions are known.
2. Rewrite page links, asset references, `srcset`, safe CSS `url(...)` values, query variants, redirects, and canonical aliases.
3. Leave external or unsaved in-scope URLs intact and explain them in the report.
4. Use deterministic, collision-safe paths for pages and assets.
5. Generate `manifest.json`, `report.json`, and `README.txt` in every usable archive.
6. Mark jobs `completed_with_warnings` when output exists with documented failures; reserve `failed` for fatal setup/storage/no-output cases.
7. Stream ZIP creation without loading the complete archive into memory.

**Verification:** extract fixture ZIPs and assert exact file paths, rewritten links, report entries, statuses, byte counts, redirects, aliases, and no duplicate entries.

## Task 4 — add durable job state, leases, and archive storage

**Depends on:** Task 3  
**Files to add/change:**

- `lib/db/src/schema/mirror.ts`
- `lib/db/src/schema/index.ts`
- `lib/db/src/migrations/*` or the project’s supported Drizzle schema application path
- `artifacts/api-server/src/lib/mirror-repository.ts`
- `artifacts/api-server/src/lib/mirror-storage.ts`
- `artifacts/api-server/src/lib/mirror-worker.ts`
- `artifacts/api-server/src/lib/mirror-jobs.ts`
- `replit.md`

**Work:**

1. Add normalized durable records for jobs, crawl work items, and archive/report metadata with indexes for status, lease expiry, and creation time.
2. Use transactions for job creation, work claiming, outcome commits, cancellation, and finalization.
3. Implement lease ownership, heartbeat, expiry recovery, and idempotent outcome writes.
4. Recover queued/running jobs on API startup without duplicating completed work.
5. Add a storage adapter with a local temporary implementation and a production durable implementation boundary. Store completed archive/report references, not large ZIPs in job rows.
6. Stream downloads from storage and return explicit not-ready/expired/storage-error responses.
7. Replace in-memory retention cleanup with metadata-aware cleanup of expired temp files and durable objects.
8. Keep the current internal bounded worker pool initially; make the repository/lease interface suitable for a later dedicated worker process.

**Verification:** run database/schema checks, restart during each crawl phase, reclaim expired leases, verify no double-finalization, verify cancellation finalization, and verify storage failure cannot report false success.

## Task 5 — expand API contracts and live progress

**Depends on:** Task 4  
**Files to add/change:**

- `artifacts/api-server/src/routes/mirror.ts`
- `lib/api-spec/openapi.yaml`
- generated API/Zod/client files under `lib/api-zod/src/generated/` and `lib/api-client-react/src/generated/`
- `artifacts/api-server/src/lib/mirror-events.ts`

**Work:**

1. Preserve existing create/list/get/cancel/download route shapes where possible.
2. Add structured status, phase, separate outcome counts, throughput, ETA, current URL, warning/error counts, archive/report availability, resumability, and retention fields.
3. Add an event-stream route for a job with heartbeat/reconnect semantics.
4. Add report/manifest endpoints or download modes without exposing raw archive storage paths.
5. Regenerate contract clients from the OpenAPI source of truth.
6. Add consistent not-found, not-ready, expired, cancelled, and storage-error responses.

**Verification:** API contract generation, route tests, curl health smoke test, SSE reconnect/fallback behavior, and compatibility checks for existing frontend calls.

## Task 6 — deliver the product-experience upgrade

**Depends on:** Task 5  
**Files to add/change:**

- `artifacts/site-mirror/src/pages/mirror-home.tsx`
- `artifacts/site-mirror/src/pages/mirror-job.tsx`
- `artifacts/site-mirror/src/pages/mirror-history.tsx`
- `artifacts/site-mirror/src/pages/mirror-archive.tsx`
- `artifacts/site-mirror/src/components/mirror-progress.tsx`
- `artifacts/site-mirror/src/components/mirror-report.tsx`
- `artifacts/site-mirror/src/components/archive-browser.tsx`
- `artifacts/site-mirror/src/App.tsx`
- `artifacts/site-mirror/src/index.css`

**Work:**

1. Add a plain-language scope summary before submission while keeping the simple form flow.
2. Replace “pages found/downloaded” emphasis with phase progress and discovered/saved/skipped/failed/remaining counts.
3. Show throughput, ETA, current URL, retry activity, warnings, and a readable event/error log.
4. Add warning-complete, resumable, retry-failed, cancelled, expired, and storage-error states.
5. Add searchable/filterable history with age, status, warning, size, and archive/report actions.
6. Add a read-only archive browser with file tree, metadata, report details, and isolated/sanitized static preview; never execute archived scripts in the app origin.
7. Add direct routes for archive review and preserve refresh/share behavior.
8. Meet keyboard, focus, semantic-label, contrast, status-announcement, reduced-motion, and mobile layout requirements.

**Verification:** build/typecheck, responsive screenshots, keyboard pass, accessibility checks, and one end-to-end critical journey covering start → monitor → warning report → archive browse → ZIP download.

## Task 7 — hardening, documentation, and release verification

**Depends on:** Tasks 1–6  
**Files to add/change:**

- `scripts/verify.mjs`
- root and artifact package scripts as needed
- `README.md`
- `replit.md`
- `.replit` only if the validated runtime requires a minimal change

**Work:**

1. Add fixture, restart/recovery, archive integrity, API, and frontend checks to the project verification command.
2. Run typecheck, all builds, health smoke test, representative local multi-page crawl, and archive extraction validation.
3. Check workflow logs and browser console output after the final restart.
4. Confirm cleanup and retention behavior under repeated jobs.
5. Update usage/runtime documentation with the new report fields and archive layout.
6. Republish the autoscale deployment only after all checks pass, then start a new production crawl to verify the live build.

**Verification:** `pnpm run verify`, clean workflow logs, successful preview, successful deployed health probe, and a new production job with non-zero discovered and saved page counts.

## Delivery gates

- Do not begin Stage 2 until Stage 1 proves the completeness bug is fixed with a fixture and real-world reproduction.
- Do not begin Stage 3 until durable recovery and archive availability pass restart tests.
- Do not call a job fully complete when its report contains failed or skipped eligible URLs; use the warning-complete state.
- Do not publish failed or stale production jobs; create a fresh job after republishing.