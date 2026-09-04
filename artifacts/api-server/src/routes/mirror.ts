import { Router, type IRouter, type Request, type Response } from "express";
import {
  CancelMirrorJobParams,
  CreateMirrorJobBody,
  DownloadMirrorJobParams,
  GetMirrorJobParams,
  ListMirrorJobsQueryParams,
} from "@workspace/api-zod";
import {
  cancelMirrorJob,
  createMirrorJob,
  getMirrorJob,
  getMirrorPreviewFile,
  getMirrorPreviewStartPath,
  getPublicMirrorJob,
  listMirrorJobs,
  streamMirrorZip,
} from "../lib/mirror-jobs";
import { createJobLimiter } from "../middlewares/rate-limit";

const router: IRouter = Router();

async function serveMirrorPreview(req: Request, res: Response): Promise<void> {
  const jobId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = getMirrorJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Mirror job not found." });
    return;
  }
  if (job.status !== "completed" && job.status !== "completed_with_warnings") {
    res.status(409).json({ error: "The mirror is not complete yet." });
    return;
  }
  if (!job.archiveKey) {
    res.status(404).json({ error: "The mirror preview is no longer available." });
    return;
  }

  const requestedPath = Array.isArray(req.params.previewPath)
    ? req.params.previewPath.join("/")
    : req.params.previewPath;
  if (!requestedPath) {
    const startPath = getMirrorPreviewStartPath(job);
    if (!startPath) {
      res.status(404).json({ error: "The mirrored starting page is not available." });
      return;
    }
    const encodedPath = startPath.split("/").map(encodeURIComponent).join("/");
    res.redirect(`/api/mirror-jobs/${job.id}/preview/${encodedPath}`);
    return;
  }

  try {
    const file = await getMirrorPreviewFile(job, requestedPath);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms");
    res.sendFile(file);
  } catch (error) {
    req.log.error({ err: error, jobId: job.id, requestedPath }, "Failed to serve mirror preview");
    res.status(404).json({ error: "The preview file is not available." });
  }
}

router.get("/mirror-jobs", (req, res) => {
  const parsed = ListMirrorJobsQueryParams.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit : undefined;
  const jobs = listMirrorJobs(limit).map(getPublicMirrorJob);
  res.json({ jobs });
});

router.post("/mirror-jobs", createJobLimiter, async (req, res) => {
  const parsed = CreateMirrorJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the URL and crawl settings." });
    return;
  }

  try {
    const job = await createMirrorJob(parsed.data);
    res.status(202).json(getPublicMirrorJob(job));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start mirror.";
    res.status(400).json({ error: message });
  }
});

router.get("/mirror-jobs/:id", (req, res) => {
  const parsed = GetMirrorJobParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "Mirror job not found." });
    return;
  }
  const job = getMirrorJob(parsed.data.id);
  if (!job) {
    res.status(404).json({ error: "Mirror job not found." });
    return;
  }
  res.json(getPublicMirrorJob(job));
});

router.post("/mirror-jobs/:id/cancel", async (req, res) => {
  const parsed = CancelMirrorJobParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "Mirror job not found." });
    return;
  }
  const job = await cancelMirrorJob(parsed.data.id);
  if (!job) {
    res.status(404).json({ error: "Mirror job not found." });
    return;
  }
  res.json(getPublicMirrorJob(job));
});

router.get("/mirror-jobs/:id/preview", serveMirrorPreview);
router.get("/mirror-jobs/:id/preview/{*previewPath}", serveMirrorPreview);

router.get("/mirror-jobs/:id/download", async (req, res) => {
  const parsed = DownloadMirrorJobParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "Mirror job not found." });
    return;
  }
  const job = getMirrorJob(parsed.data.id);
  if (!job) {
    res.status(404).json({ error: "Mirror job not found." });
    return;
  }
  if (job.status !== "completed" && job.status !== "completed_with_warnings") {
    res.status(409).json({ error: "The mirror is not complete yet." });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="site-mirror-${job.id.slice(0, 8)}.zip"`,
  );
  try {
    await streamMirrorZip(job, res);
  } catch (error) {
    req.log.error({ err: error, jobId: job.id }, "Failed to stream mirror archive");
    if (!res.headersSent) res.status(500).json({ error: "Unable to create the archive." });
  }
});

export default router;
