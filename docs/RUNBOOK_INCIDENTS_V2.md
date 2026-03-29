# Incident Runbook v2 (Docker Compose)

## Scope

This runbook covers the most common production incidents for the v2 stack:

- `postgres`
- `minio`
- `icecast`
- `liquidsoap`
- `api`
- `worker-playout`
- `worker-transcode`
- `web`
- `nginx`

If observability is enabled, use Grafana's `PINE v2 Playback Health` dashboard and the Prometheus alerts in `infra/observability/prometheus/alerts/pine_v2.yml`.

All commands assume project root and env file:

```bash
cd /path/to/web-radio
export COMPOSE="docker compose --env-file infra/.env -f infra/docker-compose.v2.yml"
```

## 1) No sound for listeners

1. Check web and API are healthy:

```bash
curl -fsS http://localhost/nginx-health
curl -fsS http://localhost/api/health/ready
```

2. Check Icecast and Liquidsoap logs:

```bash
$COMPOSE logs --tail=200 icecast
$COMPOSE logs --tail=200 liquidsoap
```

3. Check playout worker heartbeat / command processing:

```bash
$COMPOSE logs --tail=200 worker-playout
```

4. Validate stream endpoint directly:

```bash
curl -I http://localhost/live.mp3
```

If `5xx` or timeout appears, restart audio pipeline:

```bash
$COMPOSE restart liquidsoap icecast worker-playout
```

## 2) Track stream returns 404 / missing media

1. Check API logs for `NotFound` and storage errors:

```bash
$COMPOSE logs --tail=200 api
```

2. Check MinIO service and bucket initialization:

```bash
$COMPOSE ps minio minio-init
$COMPOSE logs --tail=200 minio minio-init
```

3. Verify object storage credentials in API container:

```bash
$COMPOSE exec api sh -lc 'env | grep -E "MINIO_|STORAGE_PATH|DATABASE_URL"'
```

4. If `minio-init` failed, rerun it:

```bash
$COMPOSE up -d minio
$COMPOSE run --rm minio-init
```

## 3) Queue commands are delayed or stuck

1. Inspect API + playout logs:

```bash
$COMPOSE logs --tail=200 api worker-playout
```

2. Validate DB connectivity from API:

```bash
$COMPOSE exec api sh -lc 'pnpm exec prisma migrate status'
```

3. Restart queue path safely:

```bash
$COMPOSE restart api worker-playout
```

4. If still stuck, check DB locks / long queries (PostgreSQL):

```bash
$COMPOSE exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT pid, wait_event_type, wait_event, state, query FROM pg_stat_activity WHERE datname = current_database();"'
```

## 4) Uploads fail or covers/transcodes are missing

1. Check API and transcode worker:

```bash
$COMPOSE logs --tail=250 api worker-transcode
```

2. Confirm worker container has expected env:

```bash
$COMPOSE exec worker-transcode sh -lc 'env | grep -E "MINIO_|DATABASE_URL|NODE_ENV"'
```

3. Restart transcode worker:

```bash
$COMPOSE restart worker-transcode
```

## 5) API is up but web is stale / socket not updating

1. Validate socket proxy in nginx:

```bash
curl -I http://localhost/socket.io/
```

2. Check logs:

```bash
$COMPOSE logs --tail=200 nginx web api
```

3. Restart frontend path:

```bash
$COMPOSE restart web nginx
```

## 6) OOM / random process kills

1. Confirm OOM in host kernel log:

```bash
dmesg -T | tail -n 200 | grep -i -E "oom|killed process"
```

2. Identify highest memory consumers:

```bash
$COMPOSE stats --no-stream
```

3. Immediate mitigation:
- Restart affected service.
- Reduce parallel jobs / worker concurrency.
- Add swap and/or increase VM RAM.

## 7) Full stack restart order

If state is inconsistent and fast recovery is needed:

```bash
$COMPOSE down
$COMPOSE up -d postgres minio
$COMPOSE up -d minio-init
$COMPOSE up -d icecast liquidsoap
$COMPOSE up -d api worker-playout worker-transcode
$COMPOSE up -d web nginx
$COMPOSE ps
```

## 8) Rollback procedure

1. Checkout known-good commit/tag.
2. Rebuild and restart:

```bash
git checkout <stable_tag_or_commit>
$COMPOSE up -d --build
```

3. If schema is incompatible, stop and execute planned DB rollback before API start.

## 9) Post-incident checklist

1. Save logs for affected interval:

```bash
$COMPOSE logs --since 30m api web worker-playout worker-transcode icecast liquidsoap minio postgres nginx > /tmp/pine-incident.log
```

2. Document:
- Root cause
- Detection gap
- Permanent fix
- Owner and due date
