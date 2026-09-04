# Mirror Studio expansion design

## Goal

Evolve Site Mirror from a reliable crawl-and-download tool into a trustworthy
archive workspace for authorized website snapshots. The system should make
crawl health legible, preserve useful results when individual URLs fail, and
let a user inspect the archive without downloading it first.

The current Puppeteer crawler, Postgres job metadata, local/object-storage
archives, and preview route remain the foundation. This design adds bounded
capabilities around those systems instead of replacing the crawler.

## Product principles

- **Evidence over optimism:** every discovered URL ends with an explicit
  saved, skipped, or failed outcome and a human-readable reason.
- **Partial results are first-class:** a crawl with useful pages and some
  failures remains inspectable and downloadable.
- **Safe by default:** public URL validation, same-origin rules, robots
  handling, archive path validation, crawl limits, and preview sandboxing stay
  mandatory.
- **Recovery is visible:** retry, resume, and cleanup operations explain what
  they will do and never silently discard an archive.
- **The archive is the product:** preview, file browsing, search, and link
  diagnostics all operate on the sealed snapshot rather than the live site.

## Architecture

### 1. Job lifecycle and crawl reliability

Extend the job model with durable operational state:

- job-level counters for queued, active, saved, skipped, failed, retried, and
  exhausted work items;
- per-work-item attempt count, last error category, last HTTP status, final URL,
  archive path, and timestamps;
- a resumable job cursor and retry policy metadata;
- a cleanup state that distinguishes active, sealed, expired, and cleanup-failed
  archives.

Keep the existing queue as the execution mechanism, but make database work
items the source of truth after restart. On recovery, reset leases that have
expired, preserve completed outcomes, and requeue only unfinished work.

Add operations for:

- retrying selected failed URLs;
- retrying all retryable failures;
- resuming an interrupted job;
- cancelling queued work without deleting completed results;
- explicitly expiring and cleaning an archive.

Retries must use bounded exponential backoff with jitter, classify errors into
retryable and permanent categories, and enforce the job's existing page,
timeout, byte, and concurrency limits.

### 2. Redirects, assets, robots, and failure recovery

Centralize URL processing through a validated request policy:

- validate every redirect hop, not only the final URL;
- retain the requested URL and final URL separately;
- normalize fragments and canonicalize equivalent URLs before queueing;
- cache robots rules per origin with explicit fetch failures;
- treat robots fetch failures as a visible policy decision rather than a silent
  allow/deny fallback;
- use the same size, timeout, origin, and content checks for pages and assets;
- preserve non-HTML responses and infer safe extensions from content type;
- sniff only generic responses for HTML, never reinterpret known binary types;
- record asset references separately from asset downloads so broken references
  are diagnosable.

All failure paths must close browser pages, response streams, ZIP streams, and
temporary extraction directories. Cleanup is idempotent and safe to retry.

### 3. Archive validation and inspection

At archive seal time:

- write a manifest containing archive version, job settings, file entries,
  content types, byte sizes, source URLs, final URLs, and outcome status;
- validate that every manifest entry exists and remains inside the archive root;
- validate ZIP readability before exposing download or preview actions;
- generate a link report by resolving rewritten internal links against the
  manifest and classifying them as valid, missing, external, or unsupported;
- retain failed and skipped outcome records in the report.

Add a read-only archive inspection API:

- list files with path, type, size, source URL, and outcome metadata;
- search files/pages/resources by path, URL, content type, and status;
- return aggregate archive health and broken-link summaries;
- return a safe file preview/download response using the existing extraction
  protection.

The file browser should lazy-load archive entries and never extract an entire
large archive just to render a directory listing. Extraction remains lazy and
job-scoped.

### 4. Preview workspace

Replace the single-frame preview experience with a preview workspace:

- breadcrumb navigation for archive paths;
- current file metadata and source URL;
- page/resource search;
- previous/next navigation through saved HTML pages;
- a diagnostics drawer showing broken links, missing assets, and failed related
  URLs;
- an open-in-new-tab action that preserves the safe preview headers;
- clear handling for HTML, images, text, PDFs, and unsupported binary files.

The preview remains sandboxed and read-only. It never navigates to an arbitrary
live origin through archive links.

### 5. Guided crawl setup and job operations

Refine the home flow into a guided setup:

- presets for quick snapshot, documentation site, asset-heavy site, and
  cautious crawl;
- advanced settings behind progressive disclosure;
- inline validation for URL, page limit, depth, timeout, byte limit, delay,
  robots, assets, include/exclude paths;
- a preflight summary showing expected scope and safety constraints;
- duplicate-job detection for an active or recently completed equivalent job,
  with explicit choices to open the existing job or start another.

The job page becomes a live operations dashboard:

- crawl health headline and progress phase;
- queue summary and throughput;
- saved/skipped/failed breakdown;
- active URL and latest outcomes;
- retry/resume/cancel controls with confirmation for destructive actions;
- archive readiness, size, validation state, and preview availability.

History gains search, status filters, date sorting, URL filtering, and a clear
empty state. All controls remain keyboard reachable with visible focus states,
44px minimum touch targets, labels for icon buttons, and reduced-motion support.

### 6. Operational hardening

Add automated coverage around:

- non-HTML preservation and content-type extension inference;
- redirect and same-origin enforcement;
- robots policy outcomes;
- retry classification and restart recovery;
- archive traversal protection and manifest validation;
- link rewriting and link-integrity reporting;
- duplicate detection and cleanup idempotency;
- large archive listing without eager extraction.

Use structured events for job transitions, work-item outcomes, retries,
archive sealing, extraction, cleanup, and API errors. Logs must include job ID,
work-item URL, category, attempt, and duration without logging secrets.

Add abuse protection at the job boundary: concurrent-job limits, request
rate-limits, maximum archive size, maximum URLs, maximum redirect hops, maximum
retry budget, and per-origin request throttling.

## Data flow

1. User submits guided crawl settings.
2. API validates settings and checks for equivalent active/recent jobs.
3. Job is persisted with a durable queue and safety limits.
4. Worker leases work items, validates every request, records outcomes, and
   emits structured progress events.
5. Sealing writes and validates the manifest, link report, and archive.
6. Inspection APIs read manifest/report metadata first and extract files lazily.
7. The UI consumes job snapshots and inspection data through polling initially,
   with a future event stream boundary left open.

## Error handling

- API errors return stable error categories and actionable messages.
- UI errors appear next to the affected operation and preserve retry context.
- A failed individual URL never causes silent loss of the rest of the crawl.
- A failed archive seal prevents preview/download actions and marks the job as
  archive-invalid with cleanup guidance.
- Cleanup failures are retained for later retry rather than hidden.

## Delivery sequence

1. **Reliability foundation:** durable work-item state, retry/resume controls,
   error classification, restart recovery, cleanup hardening, and regression
   tests.
2. **Archive intelligence:** manifest validation, file listing/search,
   link-integrity report, diagnostics API, and archive health metadata.
3. **Preview workspace:** breadcrumbs, file browser, resource/page search,
   diagnostics drawer, and safe non-HTML viewers.
4. **Guided product experience:** presets, preflight, duplicate detection,
   live dashboard, history filters, and improved states.
5. **Operational and visual refinement:** rate limits, structured events,
   performance tuning, accessibility pass, responsive polish, and visual
   hierarchy improvements.

Each stage must preserve the existing download and preview contracts, pass
workspace verification, and include an end-to-end test against both HTML and
non-HTML mirrors.

## Acceptance criteria

- A restarted worker resumes unfinished work without duplicating saved files or
  losing completed outcomes.
- A user can see why every discovered URL was saved, skipped, or failed and can
  retry eligible failures.
- A sealed archive is validated before preview/download and exposes a useful
  health summary.
- A user can browse/search files and navigate the mirrored site without
  leaving the sandboxed archive preview.
- Guided presets make a safe crawl possible without opening advanced settings.
- Large archives do not require eager extraction for listing or search.
- Security limits remain enforced across retries, redirects, previews, and
  cleanup.
- Automated checks cover the regressions that previously affected non-HTML
  responses, restart recovery, and archive path safety.