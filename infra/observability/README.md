# Observability v2

This folder contains the standalone observability overlay for the clean-server v2 stack.

## What is included

- Prometheus scrape config and alert rules
- Blackbox exporter config for HTTP probes
- PostgreSQL exporter custom queries for playback/queue health
- Grafana provisioning and a playback health dashboard
- A separate Docker Compose overlay for observability services

## How to run

From the repository root:

```bash
docker compose \
  --env-file infra/.env \
  -f infra/docker-compose.v2.yml \
  -f infra/observability/docker-compose.observability.yml \
  up -d --build
```

## URLs

- Prometheus: `http://localhost:${PROMETHEUS_PORT:-9090}`
- Grafana: `http://localhost:${GRAFANA_PORT:-3002}`
- Blackbox exporter: `http://localhost:${BLACKBOX_PORT:-9115}`
- PostgreSQL exporter: `http://localhost:${POSTGRES_EXPORTER_PORT:-9187}`

## Dashboard

Grafana auto-loads the `PINE v2 Playback Health` dashboard from:

- `infra/observability/grafana/dashboards/pine-v2-overview.json`

## Alert coverage

- API readiness failures
- Stream mount failures
- Missing playback heartbeat
- Playback worker stalls
- Command backlog growth
- Outbox backlog growth

## Assumptions

- The main stack is started with the base compose file first so Prometheus can reach service names like `api`, `postgres`, `icecast`, and `minio` on the shared project network.
- The PostgreSQL user used by `DATABASE_URL` can query the playback tables.
