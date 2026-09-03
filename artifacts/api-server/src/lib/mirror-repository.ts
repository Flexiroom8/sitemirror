import { desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { mirrorJobsTable, type MirrorJobRow } from "@workspace/db/schema";
import type { MirrorJobRecord } from "./mirror-jobs";

export type MirrorJobConfigSnapshot = {
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
};

export type MirrorJobProgressSnapshot = {
  pagesFound: number;
  pagesDownloaded: number;
  pagesSkipped: number;
  pagesFailed: number;
  assetsDownloaded: number;
  assetsSkipped: number;
  assetsFailed: number;
  bytesDownloaded: number;
  currentUrl: string | null;
  progressPhase: MirrorJobRecord["progressPhase"];
  message: string | null;
  timedOut: boolean;
  sizeLimitReached: boolean;
  outcomes: MirrorJobRecord["outcomes"] extends Map<string, infer T> ? T[] : never;
  discoveredUrls: string[];
  savedPages: string[];
  downloadedAssets: string[];
  redirects: Array<[string, string]>;
};

function jobConfig(job: MirrorJobRecord): MirrorJobConfigSnapshot {
  return {
    maxPages: job.maxPages,
    requestDelayMs: job.requestDelayMs,
    respectRobotsTxt: job.respectRobotsTxt,
    maxDepth: job.maxDepth,
    includeAssets: job.includeAssets,
    pathPrefix: job.pathPrefix,
    excludePaths: job.excludePaths,
    timeoutMs: job.timeoutMs,
    maxTotalBytes: job.maxTotalBytes,
    maxAssetBytes: job.maxAssetBytes,
  };
}

function jobProgress(job: MirrorJobRecord): MirrorJobProgressSnapshot {
  return {
    pagesFound: job.pagesFound,
    pagesDownloaded: job.pagesDownloaded,
    pagesSkipped: job.pagesSkipped,
    pagesFailed: job.pagesFailed,
    assetsDownloaded: job.assetsDownloaded,
    assetsSkipped: job.assetsSkipped,
    assetsFailed: job.assetsFailed,
    bytesDownloaded: job.bytesDownloaded,
    currentUrl: job.currentUrl,
    progressPhase: job.progressPhase,
    message: job.message,
    timedOut: job.timedOut,
    sizeLimitReached: job.sizeLimitReached,
    outcomes: [...job.outcomes.values()],
    discoveredUrls: [...job.discoveredUrls],
    savedPages: [...job.savedPages],
    downloadedAssets: [...job.downloadedAssets],
    redirects: [...job.redirects.entries()],
  };
}

export async function persistMirrorJob(job: MirrorJobRecord): Promise<void> {
  const now = new Date();
  await db
    .insert(mirrorJobsTable)
    .values({
      id: job.id,
      url: job.url,
      status: job.status,
      config: jobConfig(job),
      progress: jobProgress(job),
      archiveKey: job.archiveKey,
      archiveBytes: job.archiveBytes,
      outputExpiresAt: job.completedAt
        ? new Date(new Date(job.completedAt).getTime() + 24 * 60 * 60 * 1000)
        : null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt ? new Date(job.completedAt) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: mirrorJobsTable.id,
      set: {
        status: job.status,
        config: jobConfig(job),
        progress: jobProgress(job),
        archiveKey: job.archiveKey,
        archiveBytes: job.archiveBytes,
        outputExpiresAt: job.completedAt
          ? new Date(new Date(job.completedAt).getTime() + 24 * 60 * 60 * 1000)
          : null,
        startedAt: job.startedAt,
        completedAt: job.completedAt ? new Date(job.completedAt) : null,
        updatedAt: now,
      },
    });
}

export async function listPersistedMirrorJobs(limit: number): Promise<MirrorJobRow[]> {
  return db
    .select()
    .from(mirrorJobsTable)
    .orderBy(desc(mirrorJobsTable.createdAt))
    .limit(limit);
}

export async function getPersistedMirrorJob(id: string): Promise<MirrorJobRow | undefined> {
  const rows = await db.select().from(mirrorJobsTable).where(eq(mirrorJobsTable.id, id)).limit(1);
  return rows[0];
}

export async function deletePersistedMirrorJob(id: string): Promise<void> {
  await db.delete(mirrorJobsTable).where(eq(mirrorJobsTable.id, id));
}