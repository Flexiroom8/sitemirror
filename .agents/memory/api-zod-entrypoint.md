---
name: API Zod entrypoint
description: Package-export constraint for the workspace's generated API validation schemas
---

The API server imports runtime validators from the `@workspace/api-zod` package root. The package entrypoint should export the generated runtime validators explicitly, while leaving generated TypeScript types as a wildcard export.

**Why:** The API server's typecheck can pass against source references while the esbuild workflow still fails if runtime schema exports are missing. A wildcard export of both generated modules also creates duplicate names such as `ListMirrorArchiveFilesParams`.

**How to apply:** When adding or regenerating API routes, export only the runtime schemas consumed by the server from the package root and run the API build, not only `tsc`.