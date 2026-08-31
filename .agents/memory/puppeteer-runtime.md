---
name: Puppeteer runtime
description: Environment requirements for running Puppeteer Chrome in the API service.
---

Puppeteer does not reliably bring a runnable Chrome binary into this workspace by itself. The browser must be downloaded and the workflow environment must include Chrome's Linux shared libraries.

**Why:** A mirror job can pass dependency installation and still fail at launch if either the browser cache or runtime libraries are missing.

**How to apply:** Keep a startup check that installs Chrome when its executable is absent, and keep the required Nix runtime libraries installed before restarting the API workflow.

When the API process may start from the monorepo root, invoke the Puppeteer CLI through `pnpm --filter @workspace/api-server exec`; plain `pnpm exec` cannot resolve the API package's binary from the root.

**Why:** Artifact/deployment processes do not always inherit the API package as their working directory.

**How to apply:** Use the filtered workspace invocation in both startup and runtime browser-install fallbacks, then test with an isolated `PUPPETEER_CACHE_DIR`.