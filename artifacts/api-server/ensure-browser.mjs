import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer";

const executablePath = puppeteer.executablePath();

try {
  await access(executablePath);
} catch {
  const result = spawnSync(
    "pnpm",
    ["exec", "puppeteer", "browsers", "install", "chrome"],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}