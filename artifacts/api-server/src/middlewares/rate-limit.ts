import rateLimit from "express-rate-limit";

/**
 * Starting a mirror job launches a headless browser and can run for
 * minutes, so it's the one endpoint worth protecting from being spammed.
 * Bounds are intentionally generous for normal use and env-overridable for
 * deployments that need something stricter.
 */
export const createJobLimiter = rateLimit({
  windowMs: Number(process.env["MIRROR_RATE_LIMIT_WINDOW_MS"] ?? 60_000),
  limit: Number(process.env["MIRROR_RATE_LIMIT_MAX"] ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many mirror jobs started recently. Please wait a moment and try again." },
});
