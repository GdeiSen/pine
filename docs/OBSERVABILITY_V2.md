# Observability v2

This project now has a standalone observability overlay for the clean-server v2 stack.

## Included components

- Prometheus scrape config
- Blackbox probes for HTTP health endpoints and the Icecast stream mount
- PostgreSQL exporter custom queries for playback and queue health
- Grafana provisioning
- A dashboard focused on playback, queue, and worker health
- Prometheus alert rules for the main failure modes

## Start it

From the repository root:

```bash
docker compose \
  --env-file infra/.env \
  -f infra/docker-compose.v2.yml \
  -f infra/observability/docker-compose.observability.yml \
  up -d --build
```

## Useful URLs

- Prometheus: `http://localhost:${PROMETHEUS_PORT:-9090}`
- Grafana: `http://localhost:${GRAFANA_PORT:-3002}`
- Blackbox exporter: `http://localhost:${BLACKBOX_PORT:-9115}`
- PostgreSQL exporter: `http://localhost:${POSTGRES_EXPORTER_PORT:-9187}`

## What is being monitored

- API readiness and liveness
- Web availability
- MinIO health
- Icecast root/status/stream mount
- Playback state heartbeat freshness
- Pending and processing playback commands
- Oldest command ages
- Unprocessed playback outbox events
- Queue pressure

## Alert semantics

- `PineApiDown`: API readiness is failing.
- `PineStreamMountDown`: the stream mount is unreachable.
- `PinePlaybackHeartbeatMissing`: the playout worker has not synchronized playback state recently.
- `PineWorkerStalled`: a command has been stuck in processing too long.
- `PineHighCommandBacklog`: pending commands are accumulating.
- `PineOutboxBacklog`: playback events are backing up.

## Notes

- This overlay is intentionally separate from the main application compose file so it can be added without touching application services.
- The dashboard expects the Prometheus datasource UID `prometheus`, which is provisioned automatically.
