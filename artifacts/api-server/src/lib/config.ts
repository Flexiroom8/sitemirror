import { logger } from "./logger";

export interface EnvironmentConfig {
  port: number;
  nodeEnv: "development" | "production";
  databaseUrl: string;
  mirrorMaxConcurrentJobs: number;
  mirrorAssetConcurrency: number;
  mirrorDefaultTimeoutMs: number;
  mirrorMaxTimeoutMs: number;
  mirrorDefaultMaxTotalBytes: number;
  mirrorHardMaxTotalBytes: number;
  mirrorMaxAssetBytes: number;
  mirrorJobRetentionMs: number;
  mirrorRateLimitWindowMs: number;
  mirrorRateLimitMax: number;
}

function envNumber(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { name, raw, fallback },
      `Invalid ${name}, using fallback`,
    );
    return fallback;
  }
  if (min !== undefined && parsed < min) {
    logger.warn(
      { name, value: parsed, min, fallback },
      `${name} below minimum, using fallback`,
    );
    return fallback;
  }
  if (max !== undefined && parsed > max) {
    logger.warn(
      { name, value: parsed, max },
      `${name} exceeds maximum, capping to max`,
    );
    return max;
  }
  return parsed;
}

function envString(name: string, fallback?: string): string {
  const value = process.env[name];
  if (!value && fallback === undefined) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value || fallback!;
}

/**
 * Loads and validates environment configuration from process.env.
 * Throws if any required variables are missing.
 * Applies sensible defaults and enforces min/max constraints.
 */
export function loadConfig(): EnvironmentConfig {
  const nodeEnv = (process.env.NODE_ENV || "development") as
    | "development"
    | "production";

  const port = envNumber("PORT", 5000, 1, 65535);

  // DATABASE_URL is required by the template (even if mirror feature doesn't use it)
  const databaseUrl = envString("DATABASE_URL", "");

  // Mirror-specific tuning
  const mirrorMaxConcurrentJobs = envNumber("MIRROR_MAX_CONCURRENT_JOBS", 3, 1);
  const mirrorAssetConcurrency = envNumber("MIRROR_ASSET_CONCURRENCY", 4, 1);

  const mirrorDefaultTimeoutMs = envNumber(
    "MIRROR_DEFAULT_TIMEOUT_MS",
    15 * 60 * 1000, // 15 min
    60_000, // 1 min min
  );

  const mirrorMaxTimeoutMs = envNumber(
    "MIRROR_MAX_TIMEOUT_MS",
    60 * 60 * 1000, // 60 min
    mirrorDefaultTimeoutMs, // At least as large as default
  );

  const mirrorDefaultMaxTotalBytes = envNumber(
    "MIRROR_DEFAULT_MAX_TOTAL_BYTES",
    500 * 1024 * 1024, // 500 MB
    1 * 1024 * 1024, // 1 MB min
  );

  const mirrorHardMaxTotalBytes = envNumber(
    "MIRROR_HARD_MAX_TOTAL_BYTES",
    2 * 1024 * 1024 * 1024, // 2 GB
    mirrorDefaultMaxTotalBytes, // At least as large as default
  );

  const mirrorMaxAssetBytes = envNumber(
    "MIRROR_MAX_ASSET_BYTES",
    50 * 1024 * 1024, // 50 MB
    1 * 1024 * 1024, // 1 MB min
  );

  const mirrorJobRetentionMs = envNumber(
    "MIRROR_JOB_RETENTION_MS",
    6 * 60 * 60 * 1000, // 6 hours
    60_000, // 1 min min
  );

  const mirrorRateLimitWindowMs = envNumber(
    "MIRROR_RATE_LIMIT_WINDOW_MS",
    60_000, // 60 seconds
    10_000, // 10 sec min
  );

  const mirrorRateLimitMax = envNumber(
    "MIRROR_RATE_LIMIT_MAX",
    10,
    1,
  );

  const config: EnvironmentConfig = {
    port,
    nodeEnv,
    databaseUrl,
    mirrorMaxConcurrentJobs,
    mirrorAssetConcurrency,
    mirrorDefaultTimeoutMs,
    mirrorMaxTimeoutMs,
    mirrorDefaultMaxTotalBytes,
    mirrorHardMaxTotalBytes,
    mirrorMaxAssetBytes,
    mirrorJobRetentionMs,
    mirrorRateLimitWindowMs,
    mirrorRateLimitMax,
  };

  if (nodeEnv === "development") {
    logger.info({ config }, "Loaded environment configuration");
  }

  return config;
}
