import { spawn } from "node:child_process";
import net from "node:net";

const rootDir = new URL("..", import.meta.url);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: false,
      ...options,
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} was terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.ok && body.status === "ok") return;
      throw new Error(`received HTTP ${response.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error(`Health check failed: ${lastError?.message ?? "timed out"}`);
}

async function smokeTest() {
  const port = await findAvailablePort();
  const child = spawn(pnpmCommand, ["--filter", "@workspace/api-server", "run", "start"], {
    cwd: rootDir,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
    stdio: "inherit",
    shell: false,
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  try {
    const exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(new Error(`API server exited before health check (${code ?? signal})`));
      });
    });
    await Promise.race([waitForHealth(`http://127.0.0.1:${port}/api/healthz`), exitPromise]);
    console.log("API smoke test passed: /api/healthz");
  } finally {
    if (!exited && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

try {
  await run(pnpmCommand, ["install", "--frozen-lockfile"]);
  await run(pnpmCommand, ["run", "typecheck"]);
  await run(pnpmCommand, ["-r", "--if-present", "run", "build"], {
    env: { ...process.env, PORT: process.env.PORT ?? "4173", BASE_PATH: process.env.BASE_PATH ?? "/" },
  });
  await smokeTest();
  console.log("Verification passed.");
} catch (error) {
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
}
