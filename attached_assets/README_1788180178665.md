# Site Mirror

A production-grade tool for creating authorized, searchable, downloadable archives of websites. **Site Mirror** captures complete website structures with proper asset linking and offline browsability.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![Node.js](https://img.shields.io/badge/Node.js-24.x-green)

## Features

- **🔐 Security-First**: SSRF protection, DNS-rebinding defense, IP allowlisting
- **📦 Complete Archives**: Downloads HTML, CSS, JavaScript, images, fonts, and media
- **🔗 Offline-Browsable**: Mirrors relink pages to point at each other locally
- **⚡ Concurrent Processing**: Configurable parallel crawling with rate limiting
- **🎯 Flexible Crawling**: Max depth, page limits, asset filters, robots.txt respect
- **📊 Progress Tracking**: Real-time crawl status, page/asset counts, size tracking
- **💾 Size Control**: Per-job and per-asset size limits with hard ceiling enforcement
- **🧹 Auto-Cleanup**: Configurable retention for completed jobs and temp files
- **🔄 Graceful Shutdown**: Proper signal handling, browser cleanup, resource release

## Quick Start

### Prerequisites

- Node.js 24+
- pnpm
- PostgreSQL (optional; not used by mirror feature)

### Installation

```bash
git clone https://github.com/flexiroom8/sitemirror.git
cd sitemirror
pnpm install
```

### Run Development

```bash
# Start API server (port 5000)
pnpm --filter @workspace/api-server run dev

# Start frontend (port 19316)
pnpm --filter @workspace/site-mirror run dev

# Full typecheck
pnpm run typecheck

# Build all packages
pnpm run build
```

## Configuration

### Required Environment Variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Express server port (default: 5000) |
| `DATABASE_URL` | PostgreSQL connection string (required by template, not used by mirror feature) |
| `NODE_ENV` | `development` or `production` |

### Tuning Environment Variables

All have sensible defaults and hard ceiling enforcement:

| Variable | Default | Max | Notes |
|----------|---------|-----|-------|
| `MIRROR_MAX_CONCURRENT_JOBS` | 3 | - | Parallel crawls running simultaneously |
| `MIRROR_ASSET_CONCURRENCY` | 4 | - | Parallel downloads per job |
| `MIRROR_DEFAULT_TIMEOUT_MS` | 15 min | 60 min | Per-job wall-clock limit |
| `MIRROR_DEFAULT_MAX_TOTAL_BYTES` | 500 MB | 2 GB | Archive size target |
| `MIRROR_MAX_ASSET_BYTES` | 50 MB | - | Skip larger individual assets |
| `MIRROR_JOB_RETENTION_MS` | 6 hours | - | Keep finished jobs before cleanup |
| `MIRROR_RATE_LIMIT_WINDOW_MS` | 60 sec | - | Rate limit window |
| `MIRROR_RATE_LIMIT_MAX` | 10 | - | Max jobs per window |

Example:
```bash
MIRROR_MAX_CONCURRENT_JOBS=5 \
MIRROR_DEFAULT_MAX_TOTAL_BYTES=$((2 * 1024 * 1024 * 1024)) \
pnpm --filter @workspace/api-server run dev
```

## API Reference

### Endpoints

#### Create Mirror Job
```http
POST /api/mirror-jobs
Content-Type: application/json

{
  "url": "https://example.com",
  "maxPages": 100,
  "maxDepth": 3,
  "requestDelayMs": 250,
  "respectRobotsTxt": true,
  "includeAssets": true,
  "pathPrefix": "/",
  "excludePaths": ["/admin", "/api"],
  "timeoutMs": 900000,
  "maxTotalBytes": 524288000
}
```

Response: `202 Accepted`
```json
{
  "id": "job-uuid",
  "url": "https://example.com",
  "status": "queued",
  "createdAt": "2025-01-15T10:30:00Z",
  "startedAt": null,
  "completedAt": null
}
```

#### Get Job Status
```http
GET /api/mirror-jobs/:id
```

Response: `200 OK`
```json
{
  "id": "job-uuid",
  "status": "running",
  "pagesFound": 42,
  "pagesDownloaded": 15,
  "assetsDownloaded": 89,
  "bytesDownloaded": 2847361,
  "currentUrl": "https://example.com/page-2",
  "message": null
}
```

#### List Jobs
```http
GET /api/mirror-jobs?limit=10
```

#### Cancel Job
```http
POST /api/mirror-jobs/:id/cancel
```

#### Download Archive
```http
GET /api/mirror-jobs/:id/download
```

Returns: ZIP file with all captured assets.

### Error Responses

All errors return JSON with error messages:

```json
{
  "error": "Descriptive error message"
}
```

Status codes:
- `202 Accepted` - Job created successfully
- `400 Bad Request` - Invalid parameters
- `404 Not Found` - Job not found
- `429 Too Many Requests` - Rate limit exceeded
- `500 Internal Server Error` - Unexpected error

## Architecture

### Monorepo Structure

```
sitemirror/
├── artifacts/
│   ├── api-server/          # Express API (Node.js)
│   ├── site-mirror/         # React frontend (SPA)
│   └── mockup-sandbox/      # UI component library
├── lib/
│   ├── db/                  # Drizzle ORM schema
│   ├── api-zod/             # Zod validation schemas
│   ├── api-client-react/    # Generated React hooks
│   └── api-spec/            # OpenAPI specification
├── scripts/                 # Build & verification
└── .github/                 # GitHub workflows & skills
```

### Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Language** | TypeScript | 5.9 |
| **Runtime** | Node.js | 24.x |
| **API** | Express | 5.2 |
| **Frontend** | React | 19.x |
| **Styling** | Tailwind CSS | 4.x |
| **UI Components** | Radix UI | Latest |
| **Routing** | Wouter | Latest |
| **HTTP Client** | Fetch API | Native |
| **Validation** | Zod | Latest |
| **DB (optional)** | Drizzle ORM | Latest |
| **Browser** | Puppeteer | 24.x |
| **Compression** | archiver | 7.x |
| **Build** | esbuild | 0.27 |

### Security Features

1. **SSRF Protection**
   - Validates URLs against private IP ranges
   - DNS-rebinding defense with cached lookups
   - Blocks requests to localhost, 127.0.0.1, 169.254.x.x, etc.

2. **Rate Limiting**
   - Configurable per-minute job creation limits
   - Prevents abuse and resource exhaustion

3. **Content Security Policy**
   - Strict CSP with no-inline scripts
   - Security headers via Helmet

4. **Input Validation**
   - Zod schemas for all API inputs
   - Size limits on request bodies
   - URL parsing and normalization

5. **Resource Limits**
   - Per-job timeout enforcement
   - Per-asset download limits
   - Total archive size caps

## Development

### Adding Features

1. **API Changes**: Update `lib/api-spec/openapi.yaml`, then regenerate:
   ```bash
   pnpm --filter @workspace/api-spec run codegen
   ```

2. **Type Safety**: Run typecheck before committing:
   ```bash
   pnpm run typecheck
   ```

3. **Testing**: Test both server and client:
   ```bash
   pnpm run test
   ```

### Code Organization

- **Server-side logic**: `artifacts/api-server/src/lib/`
- **API routes**: `artifacts/api-server/src/routes/`
- **Frontend pages**: `artifacts/site-mirror/src/pages/`
- **Shared types**: `lib/api-zod/src/generated/`
- **Middleware**: `artifacts/api-server/src/middlewares/`

### Performance Optimization

- Browser resource blocking reduces memory usage
- Concurrent asset downloads with configurable limits
- Efficient ZIP compression with streaming
- DNS cache reduces lookup overhead
- Request deduplication prevents duplicate asset downloads

## Troubleshooting

### Job Stuck in "Queued" State

Check the server logs:
```bash
tail -f ~/.pm2/logs/api-server-out.log
```

Verify concurrent job limit isn't reached:
```bash
curl http://localhost:5000/api/health
```

### "SSRF Protection Blocked" Error

The URL is pointing to a private IP. Verify:
- Domain resolves to public IP
- No DNS rebinding attempts
- Proxy configurations are correct

### Memory Issues

Lower concurrency settings:
```bash
MIRROR_MAX_CONCURRENT_JOBS=1 \
MIRROR_ASSET_CONCURRENCY=2 \
pnpm --filter @workspace/api-server run dev
```

### Certificate Errors

Install certificates or disable verification (dev only):
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm --filter @workspace/api-server run dev
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -am 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please ensure:
- TypeScript passes typecheck
- Code is properly formatted
- Tests pass
- No security vulnerabilities introduced

## License

MIT © Flexiroom8

## Support

- **Issues**: [GitHub Issues](https://github.com/flexiroom8/sitemirror/issues)
- **Discussions**: [GitHub Discussions](https://github.com/flexiroom8/sitemirror/discussions)
- **Security**: security@flexiroom8.dev
