# Site Mirror: staged completeness, reliability, and product experience

**Date:** 2026-09-03  
**Status:** Design approved in chat; written-spec review pending

## Summary

Site Mirror will be enhanced in three ordered stages:

1. Make archive generation complete and auditable.
2. Make production jobs durable, resumable, and observable.
3. Improve the setup, live-job, history, and archive-review experience across desktop and mobile.

The current public API, same-origin policy, robots behavior, public-URL validation, request-level SSRF defenses, crawl limits, and autoscale deployment target remain the source of truth unless a later approved design changes them.

The central correctness change is to model every URL as a work item with an explicit outcome. “Discovered” will no longer be treated as “saved,” and no URL will disappear from the final report because a response was non-2xx, non-HTML, redirected, retried, or rejected by a policy.

## Goals

- Save every eligible in-scope HTML document and same-origin asset that can be retrieved within configured limits.
- Preserve enough metadata to explain every skipped, failed, retried, redirected, and saved URL.
- Support server-rendered pages and client-rendered/SPA routes without authentication or anti-bot bypassing.
- Prevent a process restart, worker crash, or transient network failure from leaving a job permanently frozen.
- Make completed archives and their reports available beyond the lifetime of one API process.
- Make progress, warnings, and incomplete results clear to users.
- Provide a safe, read-only way to inspect an archive before downloading it.
- Keep the default page limit at 100 and the maximum at 1,000.
- Keep cancellation, throttling, concurrency limits, byte limits, cleanup, and security checks explicit and testable.

## Non-goals

- Bypassing authentication, paywalls, bot protection, CAPTCHAs, or access controls.
- Crawling across origins, private network targets, or DNS-rebinding destinations.
- Treating URL fragments as separate server documents by default.
- Building a general-purpose hosted website browser.
- Replacing the current deployment target with a multi-service platform in the first implementation.
- Persisting arbitrary third-party content outside the requested archive lifecycle and retention policy.

## Chosen approach and trade-offs

### Chosen: staged evolution with a hybrid crawl pipeline

The existing API and frontend remain in place while responsibilities are separated behind focused interfaces:

- URL policy and normalization
- discovery and queueing
- document fetching/rendering
- asset fetching
- link rewriting
- archive assembly and storage
- durable job state and progress events

The crawler will use direct response information where possible and a controlled browser page for rendered DOM and SPA behavior. This avoids relying on one browser navigation response as the only source of truth, while still supporting pages whose useful links or content appear after JavaScript execution.

### Alternatives rejected for now

**Browser-only rewrite:** easiest for rendered pages, but slower, more resource-intensive, and prone to losing useful response metadata or silently skipping a URL when navigation fails.

**HTTP-only crawler:** faster and easier to scale, but cannot reliably discover or save client-rendered routes.

**Immediate external worker rewrite:** offers the highest eventual scale, but creates unnecessary migration and deployment risk before the current completeness bug is fixed. Durable leases and storage boundaries will make a later worker split possible without changing the public API.

## Architecture

### Job lifecycle

The API creates a job and returns its identifier quickly. A crawl session then progresses through:

1. `queued`
2. `discovering`
3. `saving`
4. `downloading_assets`
5. `rewriting`
6. `packaging`
7. `completed`, `completed_with_warnings`, `cancelled`, or `failed`

The lifecycle is durable. A restart recovers unfinished jobs whose work leases have expired. Cancellation is idempotent and produces a final report rather than deleting evidence of partial work.

### Work-item state model

Each normalized URL has one durable logical record. Its outcome is one of:

- `discovered`
- `queued`
- `fetching`
- `saved`
- `skipped`
- `failed`
- `cancelled`

The record includes the requested URL, final URL if known, redirect chain, HTTP status, content type, retry count, byte count, archive path if saved, timestamps, and a bounded reason/error code.

The job summary derives separate counts for discovered, queued, active, saved pages, saved assets, skipped, failed, and remaining work. The UI must not display a single “pages found” value as if it were archive completeness.

### Crawl boundaries

The existing security and policy checks remain active at every network boundary:

- public URL validation before starting a job;
- same-origin and configured path-scope checks;
- robots.txt policy;
- DNS resolution and public-address checks;
- revalidation after redirects and before requests;
- request and response size limits;
- crawl delay, timeout, concurrency, and total page/asset limits;
- cooperative cancellation.

Fragments are removed for document identity because they do not identify separate server responses. Query strings remain part of identity. History-mode SPA routes such as `/products/42` remain distinct documents.

## Crawl and archive data flow

### URL discovery and normalization

URLs are normalized before deduplication while retaining the original source URL for diagnostics. Discovery sources include:

- anchors and area links;
- `src`, `href`, `poster`, and related resource attributes;
- `srcset` candidates;
- stylesheet and document resource references;
- links found after the browser-rendered DOM settles;
- sitemap URLs when enabled and permitted by the existing crawl policy.

Canonical links are recorded as metadata and can create an alias to a saved target only after the response is inspected. A page’s canonical tag must not cause a different in-scope URL to be skipped before that URL is evaluated; this prevents incorrect canonical tags from hiding real routes.

### Document handling

For each eligible URL, the crawler follows redirects subject to the same-origin and SSRF checks on every hop. It records both the requested and final URL.

If the final response is HTML or XHTML, the crawler saves it as a page even when the status is not 2xx, including useful error documents such as 404 and 410 responses. Authentication failures and other access-denied responses are recorded without attempting to bypass them. The status and content type are shown in the report.

For browser-rendered pages, the saved page representation is the settled DOM, while response status, headers needed for diagnostics, and content type remain in the manifest. The settle strategy is bounded by the configured timeout and does not wait forever for an idle network.

Non-HTML responses are classified as assets when their content type or URL indicates a supported resource type. They are saved under `assets/` subject to asset count and byte limits. Unsupported or oversized responses are recorded as skipped or failed with a precise reason; they are never silently dropped.

### SPA and client-rendered route support

The browser navigates each in-scope document URL in a controlled context. After a bounded settle period, the crawler extracts the rendered DOM and discovers history-mode routes. It does not execute archived scripts during archive preview.

Hash-only route changes are not separate documents by default. This is explicit in the report so users can distinguish the identity policy from a failed crawl.

### Rewriting

The crawler first completes discovery and saving, then constructs a complete URL-to-archive-path map. Rewriting happens after that map exists, so pages are not rewritten based on incomplete knowledge.

Rewriting covers:

- page links;
- asset references;
- `srcset`;
- stylesheet URLs and CSS `url(...)` references where safely parseable;
- same-origin URLs with query strings;
- redirects and canonical aliases where a saved target is known.

External URLs remain external. In-scope URLs that were not saved remain explicit in the report and are not rewritten to a misleading local path.

### Archive contract

The ZIP contains:

```text
pages/
assets/
manifest.json
report.json
README.txt
```

`manifest.json` is machine-readable and describes job configuration, source/final URLs, archive paths, statuses, content types, sizes, redirects, and aliases. `report.json` contains summary counts, warnings, failures, skipped reasons, timing, and policy decisions. `README.txt` explains how to use the offline archive and where to find the report.

Archive paths are deterministic and collision-safe. Re-running a work item cannot create duplicate entries or corrupt an already-saved file.

## Production reliability and storage

### Durable job state

Job metadata, configuration, lifecycle state, counters, timestamps, cancellation state, and report/archive references move behind a durable persistence adapter. URL outcomes and work leases use the same adapter or a compact event/record representation that can be queried for progress and recovery.

Workers claim queued work with a lease and heartbeat. If a worker exits, the lease expires and the item becomes claimable again. State transitions are idempotent, and completion is only published after the archive and report are durably committed.

The first implementation keeps worker execution in the current API artifact so it does not require a deployment rewrite. The durable lease boundary prevents duplicate work when more than one process is active and leaves a clean path to dedicated workers later.

### Archive storage

Archive bytes use a storage adapter:

- local temporary storage for development and in-progress work;
- durable production storage for completed ZIPs and reports;
- explicit retention and cleanup metadata;
- streaming downloads instead of loading a whole ZIP into application memory.

The crawler does not depend directly on a provider-specific storage API. If production storage is unavailable, the job ends with a clear storage failure rather than reporting a successful archive that cannot be downloaded.

### Retry, failure, and cancellation semantics

- Transient network, browser, and storage errors receive bounded exponential retries.
- HTTP responses are outcomes, not generic exceptions.
- Policy rejections, limit exhaustion, invalid content, and permanent request errors are terminal for that URL.
- A job with saved output plus failures completes as `completed_with_warnings`.
- A job with no usable output because of a fatal setup or storage error is `failed`.
- Cancellation stops new discovery, aborts or lets active work exit at a bounded point, releases leases, and packages the partial report when possible.

## API and frontend changes

### API

The existing create/list/get/cancel/download routes remain compatible. Responses gain structured fields for:

- phase and lifecycle status;
- separate page and asset counts;
- warning/error counts;
- current URL and throughput;
- estimated remaining time when meaningful;
- report and archive availability;
- resumability and cancellation state.

An event stream endpoint provides live progress. The frontend falls back to the existing polling pattern when the stream is unavailable or disconnected.

### Home page

The primary URL and page-limit flow stays simple. Advanced controls remain available behind a labeled section. Before submission, the form summarizes scope, limits, delay/concurrency, and likely resource cost, with validation that explains how to correct a value.

### Job page

The job page displays phase, elapsed time, throughput, estimated remaining time, current URL, separate outcome counts, retry activity, and a collapsible event/error log. It distinguishes fully complete jobs from jobs completed with warnings and provides resume/retry actions only when the job state supports them.

### History page

History is searchable and filterable by status and age. Each row exposes page count, warning state, archive size, created/completed time, and available report/archive actions. Retention or expiration is visible rather than surprising the user at download time.

### Archive browser

The archive browser is read-only. It provides a file tree, metadata, report details, and a static page preview. Preview content is isolated and sanitized so saved scripts do not execute in the application origin. Users can always download the original ZIP and machine-readable reports.

### Accessibility and responsive behavior

All controls have semantic labels and keyboard support. Focus states, status announcements, contrast, and non-color indicators are required. Progress does not rely on motion, and reduced-motion preferences are respected. Layouts support narrow mobile screens through desktop widths, and home/job/history URLs remain directly navigable after refresh.

## Testing and verification

### Unit tests

- URL normalization, query preservation, fragment policy, and canonical alias rules.
- Same-origin, redirect, DNS-rebinding, robots, and path-scope decisions.
- Content classification for HTML, XHTML, assets, unsupported types, and error statuses.
- Work-item state transitions, lease expiry, idempotent retries, cancellation, and completion rules.
- Link and asset rewriting, collisions, query strings, missing targets, and CSS references.
- Manifest/report schemas and deterministic archive paths.

### Fixture/integration tests

Use a local fixture site that includes:

- multiple linked pages and nested paths;
- 404/410 and other non-2xx HTML documents;
- redirects, redirect loops, and cross-origin redirect attempts;
- an SPA with delayed route links;
- assets referenced through `srcset`, CSS, and dynamically rendered DOM;
- robots exclusions, oversized responses, slow responses, and transient failures.

Assertions must check both ZIP contents and per-URL report outcomes. A crawl is not considered correct merely because it discovered the expected URLs.

### Reliability tests

- Kill/restart the worker during discovery, fetching, rewriting, and packaging.
- Verify expired leases are reclaimed and saved files are not duplicated.
- Verify cancellation produces a coherent partial archive/report.
- Verify storage failures do not produce false success.
- Verify concurrent workers cannot permanently lose or double-finalize a work item.

### API and UI tests

- Preserve existing API contract behavior for create, list, inspect, cancel, and download.
- Verify event-stream updates and polling fallback.
- Verify warning/error states, retry/resume controls, archive browser isolation, keyboard navigation, mobile layout, and accessible announcements.
- Run the project’s full typecheck, builds, health smoke test, and representative local multi-page crawl before delivery.

## Phased implementation order

### Stage 1: archive correctness

Fix the current completeness failure first. Introduce explicit work-item outcomes, robust response/content classification, redirect/canonical handling, SPA discovery, complete URL mapping, deterministic rewriting, and manifest/report generation. Add fixture tests and reproduce the multi-page failure locally.

### Stage 2: production reliability and scale

Add durable job/URL state, leases and recovery, storage adapters, bounded retries, durable completed archives, event progress, streaming downloads, and cleanup/retention behavior. Validate with restart and concurrency tests before republishing.

### Stage 3: UI/UX and product experience

Update setup, job monitoring, history, archive browsing, report/download actions, responsive layout, accessibility semantics, and error/retry explanations. Validate desktop and mobile preview behavior and run the full verification suite.

## Acceptance criteria

The enhancement is complete when:

1. A multi-page same-origin fixture and the previously failing real-world reproduction save all eligible HTML documents within the configured limit, or list each exception with a reason.
2. Non-2xx HTML responses are represented as documented page outcomes rather than silently disappearing.
3. Redirects, canonical aliases, SPA routes, assets, and rewrite targets are visible in the manifest/report.
4. A killed/restarted process does not leave a queued job permanently frozen, and completed archives remain downloadable through the retention window.
5. Progress distinguishes discovery from saving and clearly reports warnings and failures.
6. ZIP export, manifest/report export, and safe archive browsing work from the history and job flows.
7. Existing security boundaries and API compatibility remain intact.
8. Typecheck, builds, health smoke test, fixture tests, reliability tests, and representative UI verification pass.