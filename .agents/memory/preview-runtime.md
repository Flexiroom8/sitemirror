---
name: Artifact preview runtime
description: Durable environment constraints for the Site Mirror preview flow
---

The site-mirror web artifact and api-server artifact run as separate development services. The web Vite server needs a local `/api` proxy to the API service for direct artifact previews; production path routing is separate.

Mirrored responses can arrive with generic `application/octet-stream` metadata even when their bytes are HTML. Preview/archive path selection should use a conservative HTML body sniff for generic responses, while preserving real binary responses such as PDFs.

**Why:** Direct artifact screenshots initially loaded the web SPA instead of the API, and a valid HTML mirror rendered blank when it was saved and served as a binary file.

**How to apply:** When validating this product locally, keep the web-to-API proxy configured and test both a normal HTML snapshot and a true non-HTML response after any archive or preview changes.