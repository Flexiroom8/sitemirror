import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer";
import archiver from "archiver";
import { logger } from "./logger";

export type MirrorStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type MirrorJobRecord = {
  id: string;
  url: string;
  status: MirrorStatus;
  pagesFound: number;
  pagesDownloaded: number;
  assetsDownloaded: number;
  bytesDownloaded: number;
  maxPages: number;
  requestDelayMs: number;
  respectRobotsTxt: boolean;
  maxDepth: number;
  includeAssets: boolean;
  pathPrefix: string;
  excludePaths: string[];
  timeoutMs: number;
  maxTotalBytes: number;
  maxAssetBytes: number;
  currentUrl: string | null;
  message: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: string | null;
  outputDir: string;
  cancelRequested: boolean;
  browser: Browser | null;
  downloadedAssets: Set<string>;
  savedPages: Set<string>;
  timedOut: boolean;
  sizeLimitReached: boolean;
};

const MIRROR_USER_AGENT = "SiteMirror/1.0 (authorized archive)";
const NAV_TIMEOUT_MS = 30_000;

// Resource types we let the browser skip while navigating: we don't need a
// visual render, only the DOM, and every asset we care about is fetched
// separately (and size/scope checked) by downloadAsset(). Scripts stay on so
// client-rendered pages still produce a real DOM.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

const jobs = new Map<string, MirrorJobRecord>();
const tempRoot = path.join(os.tmpdir(), "site-mirror-jobs");

// --- Tunables (env-overridable, with safe defaults and hard ceilings) -----

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_CONCURRENT_JOBS = envNumber("MIRROR_MAX_CONCURRENT_JOBS", 3);
const ASSET_DOWNLOAD_CONCURRENCY = envNumber("MIRROR_ASSET_CONCURRENCY", 4);
const DEFAULT_JOB_TIMEOUT_MS = envNumber("MIRROR_DEFAULT_TIMEOUT_MS", 15 * 60 * 1000);
const MAX_JOB_TIMEOUT_MS = envNumber("MIRROR_MAX_TIMEOUT_MS", 60 * 60 * 1000);
const MIN_JOB_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOTAL_BYTES = envNumber("MIRROR_DEFAULT_MAX_TOTAL_BYTES", 500 * 1024 * 1024);
const HARD_MAX_TOTAL_BYTES = envNumber("MIRROR_HARD_MAX_TOTAL_BYTES", 2 * 1024 * 1024 * 1024);
const MIN_TOTAL_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = envNumber("MIRROR_MAX_ASSET_BYTES", 50 * 1024 * 1024);
const JOB_RETENTION_MS = envNumber("MIRROR_JOB_RETENTION_MS", 6 * 60 * 60 * 1000);
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// --- SSRF protection: address checks + a short-lived DNS safety cache -----
//
// assertSafePublicUrl runs once at job creation. Because DNS can change
// between then and when the browser (or a redirect, or the page's own JS)
// actually makes a request — a classic DNS-rebinding attack — every request
// the browser makes during the crawl is re-validated against the same
// checks via configureRequestInterception below.

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }

  return true;
}

const dnsSafetyCache = new Map<string, { safe: boolean; expiresAt: number }>();

async function isHostnameSafe(hostname: string): Promise<boolean> {
  const key = hostname.toLowerCase();
  const cached = dnsSafetyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.safe;

  let safe: boolean;
  if (net.isIP(key)) {
    safe = !isPrivateAddress(key);
  } else if (key === "localhost" || key.endsWith(".localhost") || key.endsWith(".local")) {
    safe = false;
  } else {
    try {
      const addresses = await lookup(key, { all: true });
      safe = addresses.length > 0 && !addresses.some(({ address }) => isPrivateAddress(address));
    } catch {
      safe = false;
    }
  }

  dnsSafetyCache.set(key, { safe, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
  return safe;
}

async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid website URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS websites are supported.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not supported.");
  }

  const safe = await isHostnameSafe(parsed.hostname);
  if (!safe) {
    throw new Error("The website resolves to a local or private network address, or could not be resolved.");
  }

  parsed.hash = "";
  return parsed;
}

function publicJob(job: MirrorJobRecord) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    pagesFound: job.pagesFound,
    pagesDownloaded: job.pagesDownloaded,
    assetsDownloaded: job.assetsDownloaded,
    bytesDownloaded: job.bytesDownloaded,
    maxPages: job.maxPages,
    requestDelayMs: job.requestDelayMs,
    respectRobotsTxt: job.respectRobotsTxt,
    maxDepth: job.maxDepth,
    includeAssets: job.includeAssets,
    pathPrefix: job.pathPrefix,
    excludePaths: job.excludePaths,
    timeoutMs: job.timeoutMs,
    maxTotalBytes: job.maxTotalBytes,
    currentUrl: job.currentUrl,
    message: job.message,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}

// A short hash of the query string is appended to the on-disk filename so
// that two URLs which differ only by query (e.g. ?page=1 vs ?page=2) don't
// collide and silently overwrite each other on disk.
function filePathForUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const cleanPath = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
  const safeSegments = cleanPath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._~-]/g, "_"));
  const querySuffix = parsed.search
    ? `~${createHash("sha1").update(parsed.search).digest("hex").slice(0, 8)}`
    : "";

  const last = safeSegments.at(-1) ?? "";
  if (!path.extname(last)) {
    safeSegments.push(`index${querySuffix}.html`);
  } else if (querySuffix) {
    const ext = path.extname(last);
    const base = last.slice(0, -ext.length);
    safeSegments[safeSegments.length - 1] = `${base}${querySuffix}${ext}`;
  }
  if (safeSegments.length === 0) safeSegments.push(`index${querySuffix}.html`);
  return path.join(parsed.hostname, ...safeSegments);
}

function sameOrigin(candidate: URL, origin: URL): boolean {
  return candidate.origin === origin.origin;
}

function normalizePathPrefix(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized === "/") return "/";
  return `/${normalized.replace(/^\/+|\/+$/g, "")}`;
}

function pathMatchesPrefix(candidatePath: string, prefix: string): boolean {
  return prefix === "/" || candidatePath === prefix || candidatePath.startsWith(`${prefix}/`);
}

function withinScope(candidate: URL, origin: URL, job: MirrorJobRecord): boolean {
  if (!sameOrigin(candidate, origin)) return false;
  if (!pathMatchesPrefix(candidate.pathname, job.pathPrefix)) return false;
  return !job.excludePaths.some((excluded) => pathMatchesPrefix(candidate.pathname, excluded));
}

function shouldSaveResource(url: URL): boolean {
  return ["http:", "https:"].includes(url.protocol);
}

// --- robots.txt: Disallow/Allow with '*' wildcards and trailing '$'  ------
// anchors, plus Crawl-delay. Still a pragmatic subset of the spec (no
// per-user-agent group precedence beyond "*"), but a real improvement over
// plain prefix matching.

type RobotsRules = {
  rules: Array<{ path: string; allow: boolean }>;
  crawlDelayMs: number | null;
};

async function loadRobots(origin: URL): Promise<RobotsRules> {
  const rules: Array<{ path: string; allow: boolean }> = [];
  let crawlDelayMs: number | null = null;
  try {
    const response = await fetch(new URL("/robots.txt", origin), {
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!response.ok) return { rules, crawlDelayMs };
    const body = await response.text();
    let applies = false;
    for (const rawLine of body.split(/\r?\n/)) {
      const [rawKey, ...rawValue] = rawLine.split("#")[0].split(":");
      const key = rawKey?.trim().toLowerCase();
      const value = rawValue.join(":").trim();
      if (key === "user-agent") {
        applies = value === "*" || value === "";
        continue;
      }
      if (!applies) continue;
      if (key === "disallow" && value) rules.push({ path: value, allow: false });
      if (key === "allow" && value) rules.push({ path: value, allow: true });
      if (key === "crawl-delay" && value) {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) crawlDelayMs = Math.round(seconds * 1000);
      }
    }
  } catch {
    // A missing or unavailable robots file does not block an authorized crawl.
  }
  return { rules, crawlDelayMs };
}

function ruleToRegex(rulePath: string): RegExp {
  const hasEndAnchor = rulePath.endsWith("$");
  const body = hasEndAnchor ? rulePath.slice(0, -1) : rulePath;
  const pattern = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}${hasEndAnchor ? "$" : ""}`);
}

function blockedByRobots(url: URL, robots: RobotsRules): boolean {
  if (robots.rules.length === 0) return false;
  const relativePath = url.pathname + url.search;
  let best: { allow: boolean; specificity: number } | null = null;
  for (const rule of robots.rules) {
    if (!rule.path) continue;
    const regex = ruleToRegex(rule.path);
    if (!regex.test(relativePath) && !regex.test(url.pathname)) continue;
    const specificity = rule.path.length;
    if (!best || specificity > best.specificity) best = { allow: rule.allow, specificity };
  }
  return best ? !best.allow : false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeFileForUrl(
  outputDir: string,
  rawUrl: string,
  body: Uint8Array,
): Promise<void> {
  const target = path.join(outputDir, filePathForUrl(rawUrl));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
}

// --- Offline link rewriting -------------------------------------------
//
// Pages are written to disk with their original hrefs during the crawl (a
// page linking to another page that hasn't been visited yet can't be
// rewritten in a single pass). Once the crawl finishes and we know exactly
// which URLs were actually saved, a second pass rewrites href/src/poster
// attributes on every saved page to relative paths that resolve correctly
// inside the downloaded archive. This is what makes the mirror actually
// browsable offline, not just a pile of individually-correct files.
//
// This is attribute-level rewriting via regex, not a full HTML parser —
// it does not rewrite `srcset` lists or URLs inside inline <style> blocks
// or CSS files. Good enough for the common case; a real HTML/CSS parser
// would be the next step if that's ever needed.

const REWRITABLE_ATTR = /\b(href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

async function rewriteSavedPageFile(
  job: MirrorJobRecord,
  pageUrl: string,
  knownUrls: Set<string>,
): Promise<void> {
  const pageFile = path.join(job.outputDir, filePathForUrl(pageUrl));
  let html: string;
  try {
    html = await fs.readFile(pageFile, "utf8");
  } catch {
    return;
  }

  const rewritten = html.replace(REWRITABLE_ATTR, (match, attr: string, dq?: string, sq?: string) => {
    const rawValue = dq ?? sq;
    if (!rawValue || /^\s*(#|mailto:|tel:|javascript:|data:)/i.test(rawValue)) return match;

    let target: URL;
    try {
      target = new URL(rawValue, pageUrl);
    } catch {
      return match;
    }
    target.hash = "";
    if (!knownUrls.has(target.href)) return match;

    const targetFile = path.join(job.outputDir, filePathForUrl(target.href));
    const relative =
      path.relative(path.dirname(pageFile), targetFile).replace(/\\/g, "/") || path.basename(targetFile);
    const quote = dq !== undefined ? '"' : "'";
    return `${attr}=${quote}${relative}${quote}`;
  });

  if (rewritten !== html) {
    await fs.writeFile(pageFile, rewritten);
  }
}

async function downloadAsset(job: MirrorJobRecord, assetUrl: string): Promise<void> {
  if (job.downloadedAssets.has(assetUrl)) return;
  if (job.bytesDownloaded >= job.maxTotalBytes) return;

  const target = new URL(assetUrl);
  if (!(await isHostnameSafe(target.hostname))) return;

  const response = await fetch(assetUrl, {
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
    headers: { "User-Agent": MIRROR_USER_AGENT },
  });
  if (!response.ok) return;

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > job.maxAssetBytes) {
    logger.debug({ assetUrl, declaredLength, jobId: job.id }, "Skipped asset: exceeds per-asset size limit");
    return;
  }

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > job.maxAssetBytes) return;
  if (job.bytesDownloaded + body.byteLength > job.maxTotalBytes) {
    job.sizeLimitReached = true;
    return;
  }

  await writeFileForUrl(job.outputDir, assetUrl, body);
  job.downloadedAssets.add(assetUrl);
  job.assetsDownloaded += 1;
  job.bytesDownloaded += body.byteLength;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const runnerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await worker(item);
      }
    }),
  );
}

// Re-validates every request the page makes (not just the initial
// navigation) against the same private-address rules, closing the
// time-of-check/time-of-use gap a DNS-rebinding attack would exploit.
// Also skips resource types we don't need for a DOM-only crawl.
async function configureRequestInterception(page: Page, job: MirrorJobRecord): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (req: HTTPRequest) => {
    void (async () => {
      try {
        if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
          await req.abort("blockedbyclient");
          return;
        }

        let target: URL;
        try {
          target = new URL(req.url());
        } catch {
          await req.abort("blockedbyclient");
          return;
        }

        if (["data:", "blob:", "about:"].includes(target.protocol)) {
          await req.continue();
          return;
        }
        if (!["http:", "https:"].includes(target.protocol)) {
          await req.abort("blockedbyclient");
          return;
        }
        if (!(await isHostnameSafe(target.hostname))) {
          logger.warn({ url: target.href, jobId: job.id }, "Blocked request to a local or private address");
          await req.abort("blockedbyclient");
          return;
        }
        await req.continue();
      } catch {
        await req.abort("blockedbyclient").catch(() => undefined);
      }
    })();
  });
}

async function runJob(job: MirrorJobRecord): Promise<void> {
  const origin = await assertSafePublicUrl(job.url);
  const robots = job.respectRobotsTxt ? await loadRobots(origin) : { rules: [], crawlDelayMs: null };
  const effectiveDelayMs = Math.min(Math.max(job.requestDelayMs, robots.crawlDelayMs ?? 0), 30_000);

  const queue: Array<{ url: string; depth: number }> = [{ url: origin.href, depth: 0 }];
  const queuedUrls = new Set([origin.href]);
  const seen = new Set<string>();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  job.browser = browser;
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  await configureRequestInterception(page, job);

  try {
    while (queue.length > 0 && seen.size < job.maxPages) {
      if (job.cancelRequested) {
        job.status = "cancelled";
        job.message = "Mirror cancelled.";
        return;
      }
      if (job.startedAt && Date.now() - job.startedAt.getTime() > job.timeoutMs) {
        job.timedOut = true;
        break;
      }
      if (job.bytesDownloaded >= job.maxTotalBytes) {
        job.sizeLimitReached = true;
        break;
      }

      const queueEntry = queue.shift()!;
      const current = queueEntry.url;
      if (seen.has(current)) continue;
      const currentUrl = new URL(current);
      if (!withinScope(currentUrl, origin, job) || blockedByRobots(currentUrl, robots)) {
        continue;
      }
      seen.add(current);
      job.pagesFound = Math.max(job.pagesFound, seen.size + queue.length);
      job.currentUrl = current;

      try {
        const response = await page.goto(current, { waitUntil: "domcontentloaded" });
        if (!response || !response.ok()) continue;

        // A same-origin URL can still redirect off-origin server-side;
        // re-check scope against where we actually landed.
        const finalUrl = new URL(response.url());
        if (!sameOrigin(finalUrl, origin)) {
          logger.debug({ from: current, to: finalUrl.href, jobId: job.id }, "Skipped page: redirected off-origin");
          continue;
        }

        if (effectiveDelayMs > 0) await sleep(effectiveDelayMs);

        const resources = await page.evaluate(() => {
          const links = new Set<string>();
          const assets = new Set<string>();
          const pageDocument = (
            globalThis as unknown as {
              document: {
                querySelectorAll: (
                  selector: string,
                ) => {
                  forEach: (
                    callback: (element: {
                      getAttribute: (name: string) => string | null;
                    }) => void,
                  ) => void;
                };
              };
            }
          ).document;
          const linkElements = pageDocument.querySelectorAll("a[href]");
          linkElements.forEach((element) => {
            const value = element.getAttribute("href");
            if (value) links.add(value);
          });
          const assetElements = pageDocument.querySelectorAll(
            "link[href], img[src], script[src], source[src], video[src], audio[src], iframe[src]",
          );
          assetElements.forEach((element) => {
            const value =
              element.getAttribute("href") ??
              element.getAttribute("src") ??
              element.getAttribute("data-src");
            if (value) assets.add(value);
          });
          const srcsetElements = pageDocument.querySelectorAll("img[srcset], source[srcset]");
          srcsetElements.forEach((element) => {
            const value = element.getAttribute("srcset");
            if (!value) return;
            for (const candidate of value.split(",")) {
              const url = candidate.trim().split(/\s+/)[0];
              if (url) assets.add(url);
            }
          });
          return { links: [...links], assets: [...assets] };
        });
        const normalizeResources = (values: string[]) =>
          values
            .map((value) => {
              try {
                const parsed = new URL(value, current);
                parsed.hash = "";
                return parsed.href;
              } catch {
                return null;
              }
            })
            .filter((value): value is string => Boolean(value));

        const normalizedLinks = normalizeResources(resources.links);
        const normalizedAssets = normalizeResources(resources.assets);
        const internalPages = normalizedLinks.filter((value) => {
          try {
            return withinScope(new URL(value), origin, job);
          } catch {
            return false;
          }
        });
        for (const pageUrl of internalPages) {
          if (
            queueEntry.depth < job.maxDepth &&
            !seen.has(pageUrl) &&
            !queuedUrls.has(pageUrl) &&
            queue.length < job.maxPages * 2
          ) {
            queue.push({ url: pageUrl, depth: queueEntry.depth + 1 });
            queuedUrls.add(pageUrl);
          }
        }
        job.pagesFound = Math.max(job.pagesFound, seen.size + queue.length);

        const assetUrls = job.includeAssets
          ? normalizedAssets.filter((value) => {
              try {
                const parsed = new URL(value);
                return withinScope(parsed, origin, job) && shouldSaveResource(parsed);
              } catch {
                return false;
              }
            })
          : [];
        await runWithConcurrency(assetUrls, ASSET_DOWNLOAD_CONCURRENCY, async (assetUrl) => {
          if (job.cancelRequested || job.bytesDownloaded >= job.maxTotalBytes) return;
          try {
            await downloadAsset(job, assetUrl);
          } catch (error) {
            logger.debug({ err: error, assetUrl, jobId: job.id }, "Asset download failed; continuing");
          }
        });

        const html = await page.content();
        await writeFileForUrl(job.outputDir, current, Buffer.from(html));
        job.savedPages.add(current);
        job.pagesDownloaded += 1;
      } catch (error) {
        // A single unavailable page should not fail the rest of the crawl.
        logger.debug({ err: error, url: current, jobId: job.id }, "Failed to crawl page; continuing");
      }
    }

    if (job.status !== "cancelled") {
      const knownUrls = new Set<string>([...job.savedPages, ...job.downloadedAssets]);
      for (const pageUrl of job.savedPages) {
        if (job.cancelRequested) break;
        await rewriteSavedPageFile(job, pageUrl, knownUrls).catch((error) => {
          logger.debug({ err: error, pageUrl, jobId: job.id }, "Failed to rewrite links for a saved page");
        });
      }

      job.status = "completed";
      const reasons: string[] = [];
      if (job.timedOut) reasons.push("time limit reached");
      if (job.sizeLimitReached) reasons.push("size limit reached");
      const suffix = reasons.length ? ` (stopped early: ${reasons.join(", ")})` : "";
      job.message = `Saved ${job.pagesDownloaded} page${job.pagesDownloaded === 1 ? "" : "s"} and ${job.assetsDownloaded} asset${job.assetsDownloaded === 1 ? "" : "s"}.${suffix}`;
    }
  } finally {
    job.currentUrl = null;
    job.completedAt = new Date().toISOString();
    job.browser = null;
    await browser.close().catch(() => undefined);
  }
}

// --- Scheduling: a bounded number of jobs run concurrently; the rest wait
// their turn. Without this, N simultaneous mirror requests would each
// launch their own Chromium instance and could exhaust server resources.

let activeJobCount = 0;
const pendingJobIds: string[] = [];

function maybeStartNext(): void {
  while (activeJobCount < MAX_CONCURRENT_JOBS && pendingJobIds.length > 0) {
    const nextId = pendingJobIds.shift()!;
    const job = jobs.get(nextId);
    if (!job || job.cancelRequested) continue;
    activeJobCount += 1;
    void runJobLifecycle(job).finally(() => {
      activeJobCount -= 1;
      maybeStartNext();
    });
  }
}

async function runJobLifecycle(job: MirrorJobRecord): Promise<void> {
  if (job.cancelRequested) {
    job.status = "cancelled";
    job.message = "Cancelled before it started.";
    job.completedAt = new Date().toISOString();
    return;
  }
  job.status = "running";
  job.startedAt = new Date();
  job.message = "Crawling same-origin pages and assets.";
  try {
    await runJob(job);
  } catch (error) {
    job.status = job.cancelRequested ? "cancelled" : "failed";
    job.message = error instanceof Error ? error.message : "Mirror failed.";
    job.completedAt = new Date().toISOString();
    logger.warn({ err: error, jobId: job.id }, "Mirror job failed");
    if (job.browser) {
      await job.browser.close().catch(() => undefined);
      job.browser = null;
    }
  }
}

function scheduleJob(id: string): void {
  pendingJobIds.push(id);
  maybeStartNext();
}

// --- Retention sweep: finished jobs (and their temp directories) are kept
// in memory only for a bounded window, so a long-running server doesn't
// leak memory or disk across many mirror jobs.

let cleanupTimer: NodeJS.Timeout | null = null;

async function sweepFinishedJobs(): Promise<void> {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const isFinished = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    if (!isFinished || !job.completedAt) continue;
    if (now - new Date(job.completedAt).getTime() < JOB_RETENTION_MS) continue;
    await fs.rm(job.outputDir, { recursive: true, force: true }).catch(() => undefined);
    jobs.delete(id);
  }
}

function scheduleCleanupSweep(): void {
  if (cleanupTimer) return;
  const intervalMs = Math.min(JOB_RETENTION_MS, 30 * 60 * 1000);
  cleanupTimer = setInterval(() => {
    void sweepFinishedJobs();
  }, intervalMs);
  cleanupTimer.unref?.();
}

scheduleCleanupSweep();

export async function createMirrorJob(input: {
  url: string;
  maxPages?: number;
  requestDelayMs?: number;
  respectRobotsTxt?: boolean;
  maxDepth?: number;
  includeAssets?: boolean;
  pathPrefix?: string;
  excludePaths?: string[];
  timeoutMs?: number;
  maxTotalBytes?: number;
}): Promise<MirrorJobRecord> {
  const safeUrl = await assertSafePublicUrl(input.url);
  const id = randomUUID();
  const outputDir = path.join(tempRoot, id);
  await fs.mkdir(outputDir, { recursive: true });
  const job: MirrorJobRecord = {
    id,
    url: safeUrl.href,
    status: "queued",
    pagesFound: 0,
    pagesDownloaded: 0,
    assetsDownloaded: 0,
    bytesDownloaded: 0,
    maxPages: input.maxPages ?? 100,
    requestDelayMs: input.requestDelayMs ?? 250,
    respectRobotsTxt: input.respectRobotsTxt ?? true,
    maxDepth: input.maxDepth ?? 3,
    includeAssets: input.includeAssets ?? true,
    pathPrefix: normalizePathPrefix(input.pathPrefix ?? "/"),
    excludePaths: (input.excludePaths ?? []).map(normalizePathPrefix),
    timeoutMs: clamp(input.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS, MIN_JOB_TIMEOUT_MS, MAX_JOB_TIMEOUT_MS),
    maxTotalBytes: clamp(input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, MIN_TOTAL_BYTES, HARD_MAX_TOTAL_BYTES),
    maxAssetBytes: MAX_ASSET_BYTES,
    currentUrl: null,
    message: "Waiting to start.",
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    outputDir,
    cancelRequested: false,
    browser: null,
    downloadedAssets: new Set<string>(),
    savedPages: new Set<string>(),
    timedOut: false,
    sizeLimitReached: false,
  };
  jobs.set(id, job);
  scheduleJob(id);
  return job;
}

export function getMirrorJob(id: string): MirrorJobRecord | undefined {
  return jobs.get(id);
}

export function listMirrorJobs(limit = 20): MirrorJobRecord[] {
  const capped = clamp(Math.trunc(limit), 1, 100);
  return [...jobs.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, capped);
}

export async function cancelMirrorJob(id: string): Promise<MirrorJobRecord | undefined> {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.status === "queued" || job.status === "running") {
    job.cancelRequested = true;
    job.message = "Cancellation requested.";
    const pendingIndex = pendingJobIds.indexOf(id);
    if (pendingIndex !== -1) {
      pendingJobIds.splice(pendingIndex, 1);
      job.status = "cancelled";
      job.message = "Cancelled before it started.";
      job.completedAt = new Date().toISOString();
    }
    await job.browser?.close().catch(() => undefined);
  }
  return job;
}

export function getPublicMirrorJob(job: MirrorJobRecord) {
  return publicJob(job);
}

export async function streamMirrorZip(job: MirrorJobRecord, response: NodeJS.WritableStream) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (error: Error) => {
    throw error;
  });
  archive.pipe(response);
  archive.directory(job.outputDir, false);
  await archive.finalize();
}

// Called on process shutdown so in-flight Chromium instances don't linger.
export async function shutdownMirrorJobs(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  await Promise.all([...jobs.values()].map((job) => job.browser?.close().catch(() => undefined)));
}
