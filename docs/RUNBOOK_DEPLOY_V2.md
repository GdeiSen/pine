# Deploy Runbook v2 (Docker Compose)

## Scope

This runbook deploys the full v2 stack with Docker Compose:

- `postgres`
- `minio` + `minio-init`
- `icecast`
- `liquidsoap`
- `api` (NestJS)
- `playback-worker`
- `media-worker`
- `web` (Next.js)
- `nginx` (reverse proxy)
- optional observability overlay: `prometheus`, `grafana`, `blackbox-exporter`, `postgres-exporter`

## 1. Prerequisites

- Docker Engine + Docker Compose plugin
- Open ports: `80` and, if you enable observability, `9090`, `3002`, `9115`, `9187`
- DNS/domain configured if not using localhost

## 2. Prepare environment

```bash
cd /path/to/web-radio
cp infra/.env.example infra/.env
```

Edit `infra/.env` and set strong secrets at minimum:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `MINIO_ROOT_PASSWORD`
- `ICECAST_SOURCE_PASSWORD`
- `ICECAST_ADMIN_PASSWORD`
- `ICECAST_RELAY_PASSWORD`
- `GRAFANA_ADMIN_PASSWORD` if you enable observability

## 3. Build and start all services

```bash
docker compose --env-file infra/.env -f infra/docker-compose.v2.yml up -d --build
```

## 4. Enable observability overlay

If you want Prometheus, Grafana, and probes:

```bash
docker compose \
  --env-file infra/.env \
  -f infra/docker-compose.v2.yml \
  -f infra/observability/docker-compose.observability.yml \
  up -d --build
```

## 5. Verify health

```bash
docker compose --env-file infra/.env -f infra/docker-compose.v2.yml ps

docker compose --env-file infra/.env -f infra/docker-compose.v2.yml logs -f api
```

Expected checks:

- API readiness: `http://<host>/api/health/ready`
- API liveness: `http://<host>/api/health/live`
- Nginx readiness: `http://<host>/nginx-health`
- MinIO console: `http://<host>:9001`
- Icecast stream: `http://<host>/live.mp3` or `http://<host>:8000/`
- Liquidsoap control snapshot: `/var/lib/liquidsoap/control/playlist.m3u`
- Web UI: `http://<host>/`
- Prometheus: `http://<host>:9090` if observability is enabled
- Grafana: `http://<host>:3002` if observability is enabled

## 6. Update / redeploy

```bash
cd /path/to/web-radio
git fetch origin
git checkout main
git pull --ff-only origin main

docker compose --env-file infra/.env -f infra/docker-compose.v2.yml up -d --build
```

If you enabled the observability overlay, rerun the combined command from section 4.

## 7. Stop / start / restart

```bash
# stop all
docker compose --env-file infra/.env -f infra/docker-compose.v2.yml down

# stop all + remove volumes (DANGEROUS: wipes DB/objects)
docker compose --env-file infra/.env -f infra/docker-compose.v2.yml down -v

# restart one service
docker compose --env-file infra/.env -f infra/docker-compose.v2.yml restart api
```

## 8. Rollback (image-level)

1. Checkout previous git tag/commit.
2. Rebuild and start:

```bash
git checkout <stable_tag_or_commit>
docker compose --env-file infra/.env -f infra/docker-compose.v2.yml up -d --build
```

3. If DB schema rollback is required, run a planned rollback procedure first.

## 9. Incident quick triage

1. No sound:
- check `liquidsoap` logs
- check `icecast` source connected
- check `playback-worker` logs
- in Grafana, inspect `PINE v2 Playback Health`

2. UI stale / wrong state:
- check `api` logs
- check `/api/health/ready`
- check websocket proxy via nginx (`/socket.io/`)

3. Upload/storage issues:
- check `minio` + `minio-init` logs
- verify buckets exist

## 10. Notes

- API runs `prisma migrate deploy` on startup in compose.
- Current stream URL is controlled by `ICECAST_PUBLIC_URL` / `PUBLIC_STREAM_URL_TEMPLATE`.
- Liquidsoap reads its playlist from `/var/lib/liquidsoap/control/playlist.m3u` and the worker rewrites it from the queue snapshot.
- For public traffic, users should use `nginx` endpoint (`http://<host>`), not internal container ports.
- Observability artifacts live in `infra/observability/`.
- Incident procedures are documented in `docs/RUNBOOK_INCIDENTS_V2.md`.
