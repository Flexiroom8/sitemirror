---
name: Puppeteer runtime
description: Environment requirements for running Puppeteer Chrome in the API service.
---

Puppeteer does not reliably bring a runnable Chrome binary into this workspace by itself. The browser must be downloaded and the workflow environment must include Chrome's Linux shared libraries.

**Why:** A mirror job can pass dependency installation and still fail at launch if either the browser cache or runtime libraries are missing.

**How to apply:** Keep a startup check that installs Chrome when its executable is absent, and keep the required Nix runtime libraries installed before restarting the API workflow.