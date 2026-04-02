# Observability (Direct Mode)

This project has a standalone observability overlay for the direct synchronized playback stack.

## Included components

- Prometheus scrape config
- Blackbox probes for HTTP health endpoints
- PostgreSQL exporter custom queries for playback and queue health
- Grafana provisioning
- A dashboard focused on playback, queue, and outbox health
- Prometheus alert rules for the main failure modes

## Start it

From the repository root:

```bash
docker compose \
  --env-file infra/.env \
  -f infra/docker-compose.direct.yml \
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
- Playback state heartbeat freshness
- Command processing latency signals (acked/rejected ratio, slow processing samples)
- Unprocessed playback outbox events
- Queue pressure

## Alert semantics

- `PineApiDown`: API readiness is failing.
- `PinePlaybackHeartbeatMissing`: playback reconciliation has not synchronized state recently.
- `PineCommandProcessingStalled`: a playback command stayed in `PROCESSING` too long.
- `PineOutboxBacklog`: playback events are backing up.

## Notes

- This overlay is intentionally separate from the main application compose file so it can be added without touching application services.
- The dashboard expects the Prometheus datasource UID `prometheus`, which is provisioned automatically.
