import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer";

const executablePath = puppeteer.executablePath();

try {
  await access(executablePath);
} catch {
  const result = spawnSync(
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
      stdio: "inherit",
      env: {
        ...process.env,
        PUPPETEER_SKIP_DOWNLOAD: "false",
      },
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}