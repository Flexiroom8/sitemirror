import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer";
import archiver from "archiver";
import { Client as ObjectStorageClient } from "@replit/object-storage";
import { logger } from "./logger";
import {
  deletePersistedMirrorJob,
  listPersistedMirrorJobs,
  persistMirrorJob,
  type MirrorJobConfigSnapshot,
  type MirrorJobProgressSnapshot,
} from "./mirror-repository";

export type MirrorStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "cancelled";

export type MirrorOutcomeStatus = "saved" | "skipped" | "failed";

export type MirrorOutcome = {
  kind: "page" | "asset";
  url: string;
  status: MirrorOutcomeStatus;
  httpStatus: number | null;
  contentType: string | null;
  finalUrl: string | null;
  archivePath: string | null;
  reason: string | null;
  attempts: number;
  bytes: number;
  updatedAt: string;
};

export type MirrorJobRecord = {
  id: string;
  url: string;
  status: MirrorStatus;
  pagesFound: number;
  pagesDownloaded: number;
  pagesSkipped: number;
  pagesFailed: number;
  assetsDownloaded: number;
  assetsSkipped: number;
  assetsFailed: number;
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
  progressPhase: "queued" | "discovering" | "saving" | "downloading_assets" | "rewriting" | "packaging";
  message: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: string | null;
  outputDir: string;
  archiveKey: string | null;
  archiveBytes: number | null;
  archiveFile: string | null;
  archiveStorageFailed: boolean;
  cancelRequested: boolean;
  browser: Browser | null;
  downloadedAssets: Set<string>;
  savedPages: Set<string>;
  outcomes: Map<string, MirrorOutcome>;
  discoveredUrls: Set<string>;
  redirects: Map<string, string>;
  timedOut: boolean;
  sizeLimitReached: boolean;
};

const MIRROR_USER_AGENT = "SiteMirror/1.0 (authorized archive)";
const NAV_TIMEOUT_MS = 30_000;
const BROWSER_INSTALL_TIMEOUT_MS = 120_000;

// Resource types we let the browser skip while navigating: we don't need a
// visual render, only the DOM, and every asset we care about is fetched
// separately (and size/scope checked) by downloadAsset(). Scripts stay on so
// client-rendered pages still produce a real DOM.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

const jobs = new Map<string, MirrorJobRecord>();
const tempRoot = path.join(os.tmpdir(), "site-mirror-jobs");
let browserReadyPromise: Promise<string> | undefined;
const persistenceTimers = new Map<string, NodeJS.Timeout>();
const useObjectStorage = process.env.NODE_ENV === "production";
let objectStorage: ObjectStorageClient | null = null;

function getObjectStorage(): ObjectStorageClient {
  if (!objectStorage) objectStorage = new ObjectStorageClient();
  return objectStorage;
}

function findSystemBrowser(): string | undefined {
  const candidates = [
    process.env["PUPPETEER_EXECUTABLE_PATH"],
    process.env["CHROME_BIN"],
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const result = spawnSync("test", ["-x", candidate], { stdio: "ignore" });
      if (result.status === 0) return candidate;
    } catch {
      // Keep looking; the deployment may expose only one browser location.
    }
  }

  for (const command of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      const result = spawnSync("which", [command], { encoding: "utf8" });
      if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    } catch {
      // Keep looking.
    }
  }

  return undefined;
}

async function ensureBrowserAvailable(): Promise<string> {
  if (!browserReadyPromise) {
    browserReadyPromise = (async () => {
      try {
        await fs.access(puppeteer.executablePath());
        return puppeteer.executablePath();
      } catch {
        const systemBrowser = findSystemBrowser();
        if (systemBrowser) {
          logger.info({ executablePath: systemBrowser }, "Using system browser for mirror jobs");
          return systemBrowser;
        }
        logger.info("Chrome is unavailable; installing it for mirror jobs");
        await new Promise<void>((resolve, reject) => {
          const installer = spawn(
            "pnpm",
            [
              "--filter",
              "@workspace/api-server",
              "exec",
              "puppeteer",
              "browsers",
              "install",
              "chrome",
            ],
            {
              cwd: process.cwd(),
              stdio: ["ignore", "ignore", "pipe"],
              env: {
                ...process.env,
                PUPPETEER_SKIP_DOWNLOAD: "false",
              },
            },
          );
          let errorOutput = "";
          let settled = false;
          const timeout = setTimeout(() => {
            installer.kill("SIGTERM");
            if (!settled) {
              settled = true;
              reject(new Error("Chrome installation timed out after two minutes."));
            }
          }, BROWSER_INSTALL_TIMEOUT_MS);
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            callback();
          };
          installer.stderr.on("data", (chunk: Buffer) => {
            errorOutput += chunk.toString();
          });
          installer.once("error", (error) => {
            finish(() => reject(error));
          });
          installer.once("close", (code) => {
            if (code === 0) {
              finish(resolve);
            } else {
              finish(() =>
                reject(
                  new Error(
                    `Chrome could not be installed automatically.${errorOutput.trim() ? ` ${errorOutput.trim()}` : ""}`,
                  ),
                ),
              );
            }
          });
        });
        await fs.access(puppeteer.executablePath());
        logger.info("Chrome is ready for mirror jobs");
        return puppeteer.executablePath();
      }
    })().catch((error) => {
      browserReadyPromise = undefined;
      throw error;
    });
  }
  return browserReadyPromise;
}

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
    pagesSkipped: job.pagesSkipped,
    pagesFailed: job.pagesFailed,
    assetsDownloaded: job.assetsDownloaded,
    assetsSkipped: job.assetsSkipped,
    assetsFailed: job.assetsFailed,
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
    progressPhase: job.progressPhase,
    message: job.message,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    archiveAvailable: Boolean(job.archiveKey) && !job.archiveStorageFailed,
  };
}

function schedulePersistence(job: MirrorJobRecord): void {
  if (persistenceTimers.has(job.id)) return;
  const timer = setTimeout(() => {
    persistenceTimers.delete(job.id);
    void persistMirrorJob(job).catch((error) => {
      logger.warn({ err: error, jobId: job.id }, "Failed to persist mirror job progress");
    });
  }, 250);
  timer.unref?.();
  persistenceTimers.set(job.id, timer);
}

async function persistImmediately(job: MirrorJobRecord): Promise<void> {
  const timer = persistenceTimers.get(job.id);
  if (timer) {
    clearTimeout(timer);
    persistenceTimers.delete(job.id);
  }
  await persistMirrorJob(job);
}

function outcomeKey(kind: MirrorOutcome["kind"], url: string): string {
  return `${kind}:${url}`;
}

function recordOutcome(job: MirrorJobRecord, outcome: Omit<MirrorOutcome, "updatedAt">): void {
  const key = outcomeKey(outcome.kind, outcome.url);
  const previous = job.outcomes.get(key);
  if (previous?.status === "saved" && outcome.status !== "saved") return;

  const next = { ...outcome, updatedAt: new Date().toISOString() };
  job.outcomes.set(key, next);

  if (previous) {
    if (previous.kind === "page") {
      if (previous.status === "skipped") job.pagesSkipped -= 1;
      if (previous.status === "failed") job.pagesFailed -= 1;
    } else {
      if (previous.status === "skipped") job.assetsSkipped -= 1;
      if (previous.status === "failed") job.assetsFailed -= 1;
    }
  }

  if (outcome.kind === "page") {
    if (outcome.status === "skipped") job.pagesSkipped += 1;
    if (outcome.status === "failed") job.pagesFailed += 1;
  } else {
    if (outcome.status === "skipped") job.assetsSkipped += 1;
    if (outcome.status === "failed") job.assetsFailed += 1;
  }
  schedulePersistence(job);
}

function isHtmlContentType(contentType: string | null | undefined): boolean {
  return Boolean(contentType && /(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType));
}

function extensionForContentType(contentType: string | null | undefined): string | null {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType) return null;

  const extensions: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/json": ".json",
    "application/ld+json": ".json",
    "application/xml": ".xml",
    "application/xhtml+xml": ".html",
    "application/javascript": ".js",
    "application/wasm": ".wasm",
    "application/zip": ".zip",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "text/css": ".css",
    "text/csv": ".csv",
    "text/plain": ".txt",
    "text/xml": ".xml",
  };
  return extensions[mimeType] ?? ".bin";
}

async function writeArchiveReports(job: MirrorJobRecord): Promise<void> {
  const outcomes = [...job.outcomes.values()].sort((a, b) => a.url.localeCompare(b.url));
  const summary = {
    discovered: job.pagesFound,
    pagesSaved: job.pagesDownloaded,
    pagesSkipped: job.pagesSkipped,
    pagesFailed: job.pagesFailed,
    assetsSaved: job.assetsDownloaded,
    assetsSkipped: job.assetsSkipped,
    assetsFailed: job.assetsFailed,
    bytesDownloaded: job.bytesDownloaded,
    timedOut: job.timedOut,
    sizeLimitReached: job.sizeLimitReached,
  };
  const manifest = {
    schemaVersion: 1,
    jobId: job.id,
    sourceUrl: job.url,
    configuration: {
      maxPages: job.maxPages,
      maxDepth: job.maxDepth,
      includeAssets: job.includeAssets,
      pathPrefix: job.pathPrefix,
      excludePaths: job.excludePaths,
      respectRobotsTxt: job.respectRobotsTxt,
      requestDelayMs: job.requestDelayMs,
      timeoutMs: job.timeoutMs,
      maxTotalBytes: job.maxTotalBytes,
    },
    summary,
    redirects: Object.fromEntries(job.redirects),
    outcomes,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: job.status,
    summary,
    warnings: outcomes
      .filter((outcome) => outcome.status !== "saved")
      .map(({ url, kind, status, reason, httpStatus, finalUrl }) => ({
        url,
        kind,
        status,
        reason,
        httpStatus,
        finalUrl,
      })),
  };
  const readme = [
    "Site Mirror archive",
    "",
    `Source: ${job.url}`,
    `Status: ${job.status}`,
    "",
    "Open pages/ for saved HTML documents and assets/ for downloaded resources.",
    "manifest.json contains machine-readable URL and file metadata.",
    "report.json lists skipped and failed resources with reasons.",
    "Only archive sites you own or have explicit permission to copy.",
    "",
  ].join("\n");

  await Promise.all([
    fs.writeFile(path.join(job.outputDir, "manifest.json"), JSON.stringify(manifest, null, 2)),
    fs.writeFile(path.join(job.outputDir, "report.json"), JSON.stringify(report, null, 2)),
    fs.writeFile(path.join(job.outputDir, "README.txt"), readme),
  ]);
}

function archiveObjectName(job: MirrorJobRecord): string {
  return `site-mirror/archives/${job.id}.zip`;
}

async function createArchiveFile(job: MirrorJobRecord): Promise<{ file: string; bytes: number }> {
  const file = path.join(tempRoot, `${job.id}.zip`);
  await fs.rm(file, { force: true }).catch(() => undefined);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(file);
    const archive = archiver("zip", { zlib: { level: 9 } });
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    output.once("close", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    output.once("error", fail);
    archive.once("error", fail);
    archive.pipe(output);
    archive.directory(job.outputDir, false);
    void archive.finalize().catch(fail);
  });

  const stats = await fs.stat(file);
  return { file, bytes: stats.size };
}

async function publishArchive(job: MirrorJobRecord): Promise<void> {
  const archive = await createArchiveFile(job);
  job.archiveFile = archive.file;
  job.archiveBytes = archive.bytes;

  if (useObjectStorage) {
    const objectName = archiveObjectName(job);
    const result = await getObjectStorage().uploadFromFilename(objectName, archive.file, { compress: false });
    if (!result.ok) throw new Error(`Archive storage failed: ${result.error.message}`);
    job.archiveKey = objectName;
  } else {
    job.archiveKey = `local:${archive.file}`;
  }
  await persistImmediately(job);
}

async function streamStoredArchive(
  job: MirrorJobRecord,
  response: NodeJS.WritableStream,
): Promise<void> {
  const source = useObjectStorage && job.archiveKey && !job.archiveKey.startsWith("local:")
    ? getObjectStorage().downloadAsStream(job.archiveKey)
    : createReadStream(job.archiveFile ?? job.archiveKey?.replace(/^local:/, "") ?? "");

  await new Promise<void>((resolve, reject) => {
    source.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    source.pipe(response);
  });
}

async function fetchWithValidatedRedirects(
  rawUrl: string,
  origin: URL,
  job: MirrorJobRecord,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = rawUrl;
  for (let redirectCount = 0; redirectCount <= 8; redirectCount += 1) {
    const currentUrl = new URL(current);
    if (!(await isHostnameSafe(currentUrl.hostname))) {
      throw new Error("The response target is not a public address.");
    }

    const response = await fetch(current, {
      signal: AbortSignal.timeout(NAV_TIMEOUT_MS),
      redirect: "manual",
      headers: { "User-Agent": MIRROR_USER_AGENT },
    });
    const location = response.headers.get("location");
    if (location && response.status >= 300 && response.status < 400) {
      const nextUrl = new URL(location, current);
      if (!sameOrigin(nextUrl, origin) || !withinScope(nextUrl, origin, job)) {
        throw new Error("The response redirected outside the allowed crawl scope.");
      }
      job.redirects.set(rawUrl, nextUrl.href);
      current = nextUrl.href;
      continue;
    }

    const finalUrl = new URL(current);
    if (!sameOrigin(finalUrl, origin) || !withinScope(finalUrl, origin, job)) {
      throw new Error("The response ended outside the allowed crawl scope.");
    }
    return { response, finalUrl };
  }
  throw new Error("The response exceeded the redirect limit.");
}

function normalizeResourceValues(values: string[], baseUrl: string): string[] {
  return values
    .map((value) => {
      try {
        const parsed = new URL(value, baseUrl);
        parsed.hash = "";
        return parsed.href;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));
}

function extractMarkupResources(markup: string): { links: string[]; assets: string[] } {
  const links = new Set<string>();
  const assets = new Set<string>();
  const attributePattern =
    /\b(href|src|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of markup.matchAll(attributePattern)) {
    const attribute = match[1]?.toLowerCase();
    const value = match[2] ?? match[3];
    if (!value) continue;
    if (attribute === "href" && /<a\b|<area\b/i.test(markup.slice(Math.max(0, match.index ?? 0) - 32, match.index ?? 0))) {
      links.add(value);
    } else if (attribute === "href" && /(?:^|[^\w])(alternate|canonical|stylesheet|icon)/i.test(markup.slice(Math.max(0, match.index ?? 0) - 120, match.index ?? 0))) {
      assets.add(value);
    } else if (attribute === "href") {
      links.add(value);
    } else {
      assets.add(value);
    }
  }

  const srcsetPattern = /\b(?:srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of markup.matchAll(srcsetPattern)) {
    for (const candidate of (match[1] ?? match[2] ?? "").split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) assets.add(url);
    }
  }
  return { links: [...links], assets: [...assets] };
}

function queueDiscoveredPages(
  job: MirrorJobRecord,
  values: string[],
  baseUrl: string,
  depth: number,
  queue: Array<{ url: string; depth: number }>,
  origin: URL,
  robots: RobotsRules,
): void {
  for (const pageUrl of values) {
    let parsed: URL;
    try {
      parsed = new URL(pageUrl);
    } catch {
      continue;
    }
    if (!withinScope(parsed, origin, job)) continue;
    if (job.discoveredUrls.has(pageUrl)) continue;

    job.discoveredUrls.add(pageUrl);
    job.pagesFound = job.discoveredUrls.size;
    if (depth >= job.maxDepth) {
      recordOutcome(job, {
        kind: "page",
        url: pageUrl,
        status: "skipped",
        httpStatus: null,
        contentType: null,
        finalUrl: null,
        archivePath: null,
        reason: "maximum link depth reached",
        attempts: 0,
        bytes: 0,
      });
      continue;
    }
    if (job.discoveredUrls.size > job.maxPages) {
      recordOutcome(job, {
        kind: "page",
        url: pageUrl,
        status: "skipped",
        httpStatus: null,
        contentType: null,
        finalUrl: null,
        archivePath: null,
        reason: "page limit reached",
        attempts: 0,
        bytes: 0,
      });
      continue;
    }
    if (blockedByRobots(parsed, robots)) {
      recordOutcome(job, {
        kind: "page",
        url: pageUrl,
        status: "skipped",
        httpStatus: null,
        contentType: null,
        finalUrl: null,
        archivePath: null,
        reason: "blocked by robots.txt",
        attempts: 0,
        bytes: 0,
      });
      continue;
    }
    if (!job.discoveredUrls.has(pageUrl)) continue;
    queue.push({ url: pageUrl, depth: depth + 1 });
  }
}

async function savePageWithFetchFallback(
  job: MirrorJobRecord,
  current: string,
  depth: number,
  queue: Array<{ url: string; depth: number }>,
  origin: URL,
  robots: RobotsRules,
): Promise<boolean> {
  const { response, finalUrl } = await fetchWithValidatedRedirects(current, origin, job);
  const contentType = response.headers.get("content-type");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > job.maxTotalBytes - job.bytesDownloaded) {
    job.sizeLimitReached = true;
    recordOutcome(job, {
      kind: "page",
      url: current,
      status: "skipped",
      httpStatus: response.status,
      contentType,
      finalUrl: finalUrl.href,
      archivePath: null,
      reason: "total byte limit reached",
      attempts: 1,
      bytes: body.byteLength,
    });
    return false;
  }

  if (isHtmlContentType(contentType)) {
    const markup = body.toString("utf8");
    const resources = extractMarkupResources(markup);
    queueDiscoveredPages(
      job,
      normalizeResourceValues(resources.links, finalUrl.href),
      finalUrl.href,
      depth,
      queue,
      origin,
      robots,
    );
  }
  await writeFileForUrl(job.outputDir, current, body, contentType);
  job.savedPages.add(current);
  job.pagesDownloaded += 1;
  job.bytesDownloaded += body.byteLength;
  recordOutcome(job, {
    kind: "page",
    url: current,
    status: "saved",
    httpStatus: response.status,
    contentType,
    finalUrl: finalUrl.href,
    archivePath: filePathForUrl(current, contentType),
    reason: null,
    attempts: 1,
    bytes: body.byteLength,
  });
  return true;
}

// A short hash of the query string is appended to the on-disk filename so
// that two URLs which differ only by query (e.g. ?page=1 vs ?page=2) don't
// collide and silently overwrite each other on disk.
function filePathForUrl(rawUrl: string, contentType?: string | null): string {
  const parsed = new URL(rawUrl);
  const cleanPath = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
  const safeSegments = cleanPath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._~-]/g, "_"));
  const querySuffix = parsed.search
    ? `~${createHash("sha1").update(parsed.search).digest("hex").slice(0, 8)}`
    : "";
  const contentExtension = extensionForContentType(contentType);

  const last = safeSegments.at(-1) ?? "";
  if (!path.extname(last)) {
    safeSegments.push(`index${querySuffix}${contentExtension ?? ".html"}`);
  } else if (querySuffix) {
    const ext = path.extname(last);
    const base = last.slice(0, -ext.length);
    safeSegments[safeSegments.length - 1] = `${base}${querySuffix}${ext}`;
  } else if (contentExtension && !isHtmlContentType(contentType) && /\.(?:html?|xhtml)$/i.test(last)) {
    const ext = path.extname(last);
    safeSegments[safeSegments.length - 1] = `${last.slice(0, -ext.length)}${contentExtension}`;
  }
  if (safeSegments.length === 0) safeSegments.push(`index${querySuffix}${contentExtension ?? ".html"}`);
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
  contentType?: string | null,
): Promise<void> {
  const target = path.join(outputDir, filePathForUrl(rawUrl, contentType));
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
  const outcome = job.outcomes.get(outcomeKey("page", pageUrl));
  if (!isHtmlContentType(outcome?.contentType)) return;

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

    const targetOutcome =
      job.outcomes.get(outcomeKey("page", target.href)) ?? job.outcomes.get(outcomeKey("asset", target.href));
    const targetFile = path.join(job.outputDir, filePathForUrl(target.href, targetOutcome?.contentType));
    const relative =
      path.relative(path.dirname(pageFile), targetFile).replace(/\\/g, "/") || path.basename(targetFile);
    const quote = dq !== undefined ? '"' : "'";
    return `${attr}=${quote}${relative}${quote}`;
  });

  if (rewritten !== html) {
    await fs.writeFile(pageFile, rewritten);
  }
}

async function downloadAsset(job: MirrorJobRecord, assetUrl: string, origin: URL): Promise<void> {
  if (job.downloadedAssets.has(assetUrl)) return;
  if (job.bytesDownloaded >= job.maxTotalBytes) {
    recordOutcome(job, {
      kind: "asset",
      url: assetUrl,
      status: "skipped",
      httpStatus: null,
      contentType: null,
      finalUrl: null,
      archivePath: null,
      reason: "total byte limit reached",
      attempts: 0,
      bytes: 0,
    });
    return;
  }

  const target = new URL(assetUrl);
  if (!(await isHostnameSafe(target.hostname))) {
    recordOutcome(job, {
      kind: "asset",
      url: assetUrl,
      status: "skipped",
      httpStatus: null,
      contentType: null,
      finalUrl: null,
      archivePath: null,
      reason: "target is not a public address",
      attempts: 1,
      bytes: 0,
    });
    return;
  }

  const response = await fetch(assetUrl, {
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
    headers: { "User-Agent": MIRROR_USER_AGENT },
  });
  const finalUrl = new URL(response.url || assetUrl);
  if (!(await isHostnameSafe(finalUrl.hostname)) || !withinScope(finalUrl, origin, job)) {
    recordOutcome(job, {
      kind: "asset",
      url: assetUrl,
      status: "skipped",
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      finalUrl: finalUrl.href,
      archivePath: null,
      reason: "redirected outside the allowed crawl scope",
      attempts: 1,
      bytes: 0,
    });
    return;
  }

  const contentType = response.headers.get("content-type");
  if (!response.ok) {
    recordOutcome(job, {
      kind: "asset",
      url: assetUrl,
      status: "failed",
      httpStatus: response.status,
      contentType,
      finalUrl: finalUrl.href,
      archivePath: null,
      reason: `HTTP ${response.status}`,
      attempts: 1,
      bytes: 0,
    });
    return;
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > job.maxAssetBytes) {
    logger.debug({ assetUrl, declaredLength, jobId: job.id }, "Skipped asset: exceeds per-asset size limit");
    recordOutcome(job, {
      kind: "asset",
      url: assetUrl,
      status: "skipped",
      httpStatus: response.status,
      contentType,
      finalUrl: finalUrl.href,
      archivePath: null,
      reason: "per-asset size limit reached",
      attempts: 1,
      bytes: 0,
    });
    return;
  }

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > job.maxAssetBytes) {
    recordOutcome(job, {
      kind: "asset",
      url: assetUrl,
      status: "skipped",
      httpStatus: response.status,
      contentType,
      finalUrl: finalUrl.href,
      archivePath: null,
      reason: "per-asset size limit reached",
      attempts: 1,
      bytes: body.byteLength,
    });
    return;
  }
  if (job.bytesDownloaded + body.byteLength > job.maxTotalBytes) {
    job.sizeLimitReached = true;
    recordOutcome(job, {
      kind: "asset",
      url: assetUrl,
      status: "skipped",
      httpStatus: response.status,
      contentType,
      finalUrl: finalUrl.href,
      archivePath: null,
      reason: "total byte limit reached",
      attempts: 1,
      bytes: body.byteLength,
    });
    return;
  }

  await writeFileForUrl(job.outputDir, assetUrl, body, contentType);
  job.downloadedAssets.add(assetUrl);
  job.assetsDownloaded += 1;
  job.bytesDownloaded += body.byteLength;
  recordOutcome(job, {
    kind: "asset",
    url: assetUrl,
    status: "saved",
    httpStatus: response.status,
    contentType,
    finalUrl: finalUrl.href,
    archivePath: filePathForUrl(assetUrl, contentType),
    reason: null,
    attempts: 1,
    bytes: body.byteLength,
  });
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
  job.progressPhase = "discovering";
  job.message = "Checking URL safety.";
  const origin = await assertSafePublicUrl(job.url);
  job.message = "Checking robots.txt.";
  const robots = job.respectRobotsTxt ? await loadRobots(origin) : { rules: [], crawlDelayMs: null };
  const effectiveDelayMs = Math.min(Math.max(job.requestDelayMs, robots.crawlDelayMs ?? 0), 30_000);
  job.message = "Preparing browser.";
  const executablePath = await ensureBrowserAvailable();

  const queue: Array<{ url: string; depth: number }> = [{ url: origin.href, depth: 0 }];
  const queuedUrls = new Set([origin.href]);
  const seen = new Set<string>();
  job.discoveredUrls.add(origin.href);
  job.pagesFound = job.discoveredUrls.size;
  job.message = "Launching browser.";
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,BackForwardCache",
      "--no-zygote",
      "--single-process",
    ],
    timeout: 30_000,
  });
  job.browser = browser;
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  await configureRequestInterception(page, job);
  job.message = "Opening the starting page.";

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
        recordOutcome(job, {
          kind: "page",
          url: current,
          status: "skipped",
          httpStatus: null,
          contentType: null,
          finalUrl: null,
          archivePath: null,
          reason: "outside the allowed scope or blocked by robots.txt",
          attempts: 0,
          bytes: 0,
        });
        continue;
      }
      seen.add(current);
      job.progressPhase = "saving";
      job.pagesFound = job.discoveredUrls.size;
      job.currentUrl = current;

      try {
        const response = await page.goto(current, { waitUntil: "domcontentloaded" });
        if (!response) {
          throw new Error("The page did not return an HTTP response.");
        }

        // A same-origin URL can still redirect off-origin server-side;
        // re-check scope against where we actually landed.
        const finalUrl = new URL(response.url());
        const contentType = response.headers()["content-type"] ?? null;
        if (!sameOrigin(finalUrl, origin) || !withinScope(finalUrl, origin, job)) {
          logger.debug({ from: current, to: finalUrl.href, jobId: job.id }, "Skipped page: redirected outside scope");
          recordOutcome(job, {
            kind: "page",
            url: current,
            status: "skipped",
            httpStatus: response.status(),
            contentType,
            finalUrl: finalUrl.href,
            archivePath: null,
            reason: "redirected outside the allowed crawl scope",
            attempts: 1,
            bytes: 0,
          });
          continue;
        }
        if (finalUrl.href !== current) job.redirects.set(current, finalUrl.href);

        const renderedContentType = await page
          .evaluate(
            () =>
              (globalThis as unknown as { document?: { contentType?: string } }).document?.contentType ?? null,
          )
          .catch(() => null);
        const savedContentType = contentType ?? renderedContentType;
        const isHtmlDocument = isHtmlContentType(contentType) || isHtmlContentType(renderedContentType);

        if (effectiveDelayMs > 0) await sleep(effectiveDelayMs);

        const resources = isHtmlDocument
          ? await page.evaluate(() => {
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
            })
          : { links: [], assets: [] };
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
          if (job.discoveredUrls.has(pageUrl)) continue;
          job.discoveredUrls.add(pageUrl);
          job.pagesFound = job.discoveredUrls.size;

          if (queueEntry.depth >= job.maxDepth) {
            recordOutcome(job, {
              kind: "page",
              url: pageUrl,
              status: "skipped",
              httpStatus: null,
              contentType: null,
              finalUrl: null,
              archivePath: null,
              reason: "maximum link depth reached",
              attempts: 0,
              bytes: 0,
            });
            continue;
          }
          if (job.discoveredUrls.size > job.maxPages) {
            recordOutcome(job, {
              kind: "page",
              url: pageUrl,
              status: "skipped",
              httpStatus: null,
              contentType: null,
              finalUrl: null,
              archivePath: null,
              reason: "page limit reached",
              attempts: 0,
              bytes: 0,
            });
            continue;
          }
          if (!seen.has(pageUrl) && !queuedUrls.has(pageUrl)) {
            queue.push({ url: pageUrl, depth: queueEntry.depth + 1 });
            queuedUrls.add(pageUrl);
          }
        }

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
        job.progressPhase = "downloading_assets";
        await runWithConcurrency(assetUrls, ASSET_DOWNLOAD_CONCURRENCY, async (assetUrl) => {
          if (job.cancelRequested || job.bytesDownloaded >= job.maxTotalBytes) return;
          try {
            await downloadAsset(job, assetUrl, origin);
          } catch (error) {
            recordOutcome(job, {
              kind: "asset",
              url: assetUrl,
              status: "failed",
              httpStatus: null,
              contentType: null,
              finalUrl: null,
              archivePath: null,
              reason: error instanceof Error ? error.message : "asset request failed",
              attempts: 1,
              bytes: 0,
            });
            logger.debug({ err: error, assetUrl, jobId: job.id }, "Asset download failed; continuing");
          }
        });

        let bodyContentType: string | null = savedContentType;
        let bodyFinalUrl = finalUrl;
        let bodyStatus = response.status();
        let body: Buffer;
        if (isHtmlDocument) {
          body = Buffer.from(await page.content());
        } else {
          // Chromium can replace downloads such as PDFs with an internal
          // viewer document. Fetch the original response through the
          // validated direct pipeline so the archive contains the source
          // bytes, not the browser viewer's HTML.
          const directResponse = await fetchWithValidatedRedirects(current, origin, job);
          bodyContentType = directResponse.response.headers.get("content-type");
          bodyFinalUrl = directResponse.finalUrl;
          bodyStatus = directResponse.response.status;
          body = Buffer.from(await directResponse.response.arrayBuffer());
        }
        if (job.bytesDownloaded + body.byteLength > job.maxTotalBytes) {
          job.sizeLimitReached = true;
          recordOutcome(job, {
            kind: "page",
            url: current,
            status: "skipped",
            httpStatus: bodyStatus,
            contentType: bodyContentType,
            finalUrl: bodyFinalUrl.href,
            archivePath: null,
            reason: "total byte limit reached",
            attempts: 1,
            bytes: body.byteLength,
          });
          continue;
        }
        await writeFileForUrl(job.outputDir, current, body, bodyContentType);
        job.savedPages.add(current);
        job.pagesDownloaded += 1;
        job.bytesDownloaded += body.byteLength;
        recordOutcome(job, {
          kind: "page",
          url: current,
          status: "saved",
          httpStatus: bodyStatus,
          contentType: bodyContentType,
          finalUrl: bodyFinalUrl.href,
          archivePath: filePathForUrl(current, bodyContentType),
          reason: null,
          attempts: 1,
          bytes: body.byteLength,
        });
      } catch (error) {
        // A browser navigation can fail even when the origin can return a
        // usable document. Fall back to a validated direct response before
        // marking the page as failed.
        try {
          await savePageWithFetchFallback(job, current, queueEntry.depth, queue, origin, robots);
        } catch (fallbackError) {
          recordOutcome(job, {
            kind: "page",
            url: current,
            status: "failed",
            httpStatus: null,
            contentType: null,
            finalUrl: null,
            archivePath: null,
            reason:
              fallbackError instanceof Error
                ? fallbackError.message
                : error instanceof Error
                  ? error.message
                  : "page request failed",
            attempts: 2,
            bytes: 0,
          });
        }
        logger.debug({ err: error, url: current, jobId: job.id }, "Failed to crawl page; continuing");
      }
    }

    if (job.status !== "cancelled") {
      job.progressPhase = "rewriting";
      const knownUrls = new Set<string>([...job.savedPages, ...job.downloadedAssets]);
      for (const pageUrl of job.savedPages) {
        if (job.cancelRequested) break;
        await rewriteSavedPageFile(job, pageUrl, knownUrls).catch((error) => {
          logger.debug({ err: error, pageUrl, jobId: job.id }, "Failed to rewrite links for a saved page");
        });
      }

      job.progressPhase = "packaging";
      const hasWarnings =
        job.pagesSkipped > 0 ||
        job.pagesFailed > 0 ||
        job.assetsSkipped > 0 ||
        job.assetsFailed > 0 ||
        job.timedOut ||
        job.sizeLimitReached;
      job.status = hasWarnings ? "completed_with_warnings" : "completed";
      const reasons: string[] = [];
      if (job.timedOut) reasons.push("time limit reached");
      if (job.sizeLimitReached) reasons.push("size limit reached");
      if (job.pagesFailed || job.assetsFailed) reasons.push(`${job.pagesFailed + job.assetsFailed} request failures`);
      if (job.pagesSkipped || job.assetsSkipped) reasons.push(`${job.pagesSkipped + job.assetsSkipped} skipped`);
      const suffix = reasons.length ? ` (stopped early: ${reasons.join(", ")})` : "";
      job.message = `Saved ${job.pagesDownloaded} page${job.pagesDownloaded === 1 ? "" : "s"} and ${job.assetsDownloaded} asset${job.assetsDownloaded === 1 ? "" : "s"}.${suffix}`;
      await writeArchiveReports(job);
      try {
        await publishArchive(job);
      } catch (error) {
        job.archiveStorageFailed = true;
        job.status = "completed_with_warnings";
        job.message += " Archive storage is temporarily unavailable.";
        logger.warn({ err: error, jobId: job.id }, "Failed to publish mirror archive");
        await persistImmediately(job);
      }
    }
  } finally {
    job.currentUrl = null;
    job.completedAt = new Date().toISOString();
    job.browser = null;
    await browser.close().catch(() => undefined);
    await persistImmediately(job).catch((error) => {
      logger.warn({ err: error, jobId: job.id }, "Failed to persist final mirror job state");
    });
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

function hydrateMirrorJob(
  row: Awaited<ReturnType<typeof listPersistedMirrorJobs>>[number],
): MirrorJobRecord {
  const config = row.config as MirrorJobConfigSnapshot;
  const progress = row.progress as MirrorJobProgressSnapshot;
  const completedAt = row.completedAt?.toISOString() ?? null;
  return {
    id: row.id,
    url: row.url,
    status: row.status as MirrorStatus,
    pagesFound: progress.pagesFound,
    pagesDownloaded: progress.pagesDownloaded,
    pagesSkipped: progress.pagesSkipped,
    pagesFailed: progress.pagesFailed,
    assetsDownloaded: progress.assetsDownloaded,
    assetsSkipped: progress.assetsSkipped,
    assetsFailed: progress.assetsFailed,
    bytesDownloaded: progress.bytesDownloaded,
    maxPages: config.maxPages,
    requestDelayMs: config.requestDelayMs,
    respectRobotsTxt: config.respectRobotsTxt,
    maxDepth: config.maxDepth,
    includeAssets: config.includeAssets,
    pathPrefix: config.pathPrefix,
    excludePaths: config.excludePaths,
    timeoutMs: config.timeoutMs,
    maxTotalBytes: config.maxTotalBytes,
    maxAssetBytes: config.maxAssetBytes,
    currentUrl: progress.currentUrl,
    progressPhase: progress.progressPhase,
    message: progress.message,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt,
    outputDir: path.join(tempRoot, row.id),
    archiveKey: row.archiveKey,
    archiveBytes: row.archiveBytes,
    archiveFile: row.archiveKey?.startsWith("local:") ? row.archiveKey.slice("local:".length) : null,
    archiveStorageFailed: !row.archiveKey && Boolean(completedAt),
    cancelRequested: false,
    browser: null,
    downloadedAssets: new Set(progress.downloadedAssets),
    savedPages: new Set(progress.savedPages),
    outcomes: new Map(progress.outcomes.map((outcome) => [outcomeKey(outcome.kind, outcome.url), outcome])),
    discoveredUrls: new Set(progress.discoveredUrls),
    redirects: new Map(progress.redirects),
    timedOut: progress.timedOut,
    sizeLimitReached: progress.sizeLimitReached,
  };
}

export async function initializeMirrorJobs(): Promise<void> {
  try {
    const rows = await listPersistedMirrorJobs(100);
    for (const row of rows) {
      const job = hydrateMirrorJob(row);
      if (job.status === "queued" || job.status === "running") {
        await fs.rm(job.outputDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.mkdir(job.outputDir, { recursive: true });
        job.status = "queued";
        job.startedAt = null;
        job.completedAt = null;
        job.currentUrl = null;
        job.progressPhase = "queued";
        job.message = "Recovered after a server restart.";
        job.cancelRequested = false;
        job.pagesFound = 0;
        job.pagesDownloaded = 0;
        job.pagesSkipped = 0;
        job.pagesFailed = 0;
        job.assetsDownloaded = 0;
        job.assetsSkipped = 0;
        job.assetsFailed = 0;
        job.bytesDownloaded = 0;
        job.downloadedAssets.clear();
        job.savedPages.clear();
        job.outcomes.clear();
        job.discoveredUrls.clear();
        job.redirects.clear();
        job.archiveKey = null;
        job.archiveBytes = null;
        job.archiveFile = null;
        job.archiveStorageFailed = false;
        job.timedOut = false;
        job.sizeLimitReached = false;
        jobs.set(job.id, job);
        pendingJobIds.push(job.id);
        await persistImmediately(job);
      } else {
        jobs.set(job.id, job);
      }
    }
    maybeStartNext();
  } catch (error) {
    logger.warn({ err: error }, "Mirror history could not be restored; continuing with in-memory jobs");
  }
}

async function runJobLifecycle(job: MirrorJobRecord): Promise<void> {
  if (job.cancelRequested) {
    job.status = "cancelled";
    job.message = "Cancelled before it started.";
    job.completedAt = new Date().toISOString();
    await persistImmediately(job).catch(() => undefined);
    return;
  }
  job.status = "running";
  job.startedAt = new Date();
  job.message = "Crawling same-origin pages and assets.";
  await persistImmediately(job).catch((error) => {
    logger.warn({ err: error, jobId: job.id }, "Failed to persist mirror job start");
  });
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
    await persistImmediately(job).catch((persistError) => {
      logger.warn({ err: persistError, jobId: job.id }, "Failed to persist failed mirror job");
    });
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
    const isFinished =
      job.status === "completed" ||
      job.status === "completed_with_warnings" ||
      job.status === "failed" ||
      job.status === "cancelled";
    if (!isFinished || !job.completedAt) continue;
    if (now - new Date(job.completedAt).getTime() < JOB_RETENTION_MS) continue;
    await fs.rm(job.outputDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(job.archiveFile ?? "", { force: true }).catch(() => undefined);
    if (useObjectStorage && job.archiveKey && !job.archiveKey.startsWith("local:")) {
      await getObjectStorage().delete(job.archiveKey, { ignoreNotFound: true }).catch(() => undefined);
    }
    await deletePersistedMirrorJob(id).catch(() => undefined);
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
    pagesSkipped: 0,
    pagesFailed: 0,
    assetsDownloaded: 0,
    assetsSkipped: 0,
    assetsFailed: 0,
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
    progressPhase: "queued",
    message: "Waiting to start.",
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    outputDir,
    archiveKey: null,
    archiveBytes: null,
    archiveFile: null,
    archiveStorageFailed: false,
    cancelRequested: false,
    browser: null,
    downloadedAssets: new Set<string>(),
    savedPages: new Set<string>(),
    outcomes: new Map<string, MirrorOutcome>(),
    discoveredUrls: new Set<string>(),
    redirects: new Map<string, string>(),
    timedOut: false,
    sizeLimitReached: false,
  };
  await persistImmediately(job);
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
    await persistImmediately(job).catch((error) => {
      logger.warn({ err: error, jobId: job.id }, "Failed to persist mirror cancellation");
    });
  }
  return job;
}

export function getPublicMirrorJob(job: MirrorJobRecord) {
  return publicJob(job);
}

export async function streamMirrorZip(job: MirrorJobRecord, response: NodeJS.WritableStream) {
  if (!job.archiveKey) {
    if (!job.outputDir) throw new Error("The mirror archive is not available.");
    await publishArchive(job);
  }
  await streamStoredArchive(job, response);
}

// Called on process shutdown so in-flight Chromium instances don't linger.
export async function shutdownMirrorJobs(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  await Promise.all([...jobs.values()].map((job) => job.browser?.close().catch(() => undefined)));
}
