# Local Development Setup

## Prerequisites

- Node.js 20+
- pnpm 10+ (`corepack enable && corepack prepare pnpm@10.33.0 --activate`)
- Docker & Docker Compose

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start infrastructure (Docker)

```bash
cd infra
docker compose -f docker-compose.direct.yml --env-file .env.local up postgres redis minio minio-init -d
```

Services will be available at:
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`
- MinIO API: `localhost:9000`
- MinIO Console: `localhost:9001`

### 3. Setup database

```bash
cd apps/server
npx prisma migrate deploy
npx prisma generate
```

### 4. Start the API server

```bash
# From project root
pnpm dev:server
```

Server will run at `http://localhost:3001/api`.

Optionally, start the media worker in another terminal:

```bash
cd apps/server
npx ts-node -r tsconfig-paths/register src/workers/media.worker.ts
```

> **Note:** The playback worker is optional for local development. Interactive commands are processed synchronously by the API.

### 5. Start the web client

```bash
# From project root
pnpm dev:web
```

Web app will run at `http://localhost:3000`.

### 6. Stop infrastructure

```bash
cd infra
docker compose -f docker-compose.direct.yml down
```

## Environment Files

| File | Purpose |
|------|---------|
| `infra/.env.local` | Docker Compose infrastructure config |
| `apps/server/.env` | Backend API & worker config |
| `apps/web/.env.local` | Frontend Next.js config |

## Architecture

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   Next.js   │◄────►│   NestJS    │◄────►│  PostgreSQL │
│  (web app)  │      │   (API)     │      │             │
└─────────────┘      └─────────────┘      └─────────────┘
                            │
                            ▼
                     ┌─────────────┐
                     │    Redis    │
                     └─────────────┘
                            │
                            ▼
                     ┌─────────────┐
                     │    MinIO    │
                     │  (storage)  │
                     └─────────────┘
```

## Troubleshooting

### Port conflicts

If ports 5432, 6379, 9000, 9001, 3000, or 3001 are already in use, edit `infra/.env.local` and `apps/server/.env` / `apps/web/.env.local` to use different ports.

### Prisma Client not found

Run `npx prisma generate` in `apps/server` after any schema change.

### MinIO buckets missing

Make sure `minio-init` service completes successfully:

```bash
cd infra
docker compose -f docker-compose.direct.yml up minio-init
```

### CORS errors

Ensure `ALLOWED_ORIGINS` in `apps/server/.env` includes `http://localhost:3000`.
