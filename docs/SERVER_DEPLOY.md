# Deploy PINE on Ubuntu Server (with existing Nginx)

Deploy the PINE web-radio project on an Ubuntu server where Nginx is already installed.

## Prerequisites

- Ubuntu 22.04+ server
- Docker + Docker Compose plugin
- Git
- Nginx (already installed on the server)
- Domain `pine.evergreen-explorers.online` pointing to your server IP

## Step 1 — Install Docker

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git curl
sudo systemctl enable docker && sudo systemctl start docker
sudo usermod -aG docker $USER
```

**Log out and log back in** (or run `newgrp docker`) for group changes to take effect.

## Step 2 — Clone the project

```bash
cd ~
git clone https://github.com/GdeiSen/pine.git
cd pine
```

## Step 3 — Configure environment

```bash
cp infra/.env.server.example infra/.env
nano infra/.env
```

### Required changes

```env
# Database
POSTGRES_PASSWORD=your_very_strong_password_here

# Auth secrets (generate with: openssl rand -hex 32)
JWT_SECRET=your_64_char_hex_secret_here
JWT_REFRESH_SECRET=your_another_64_char_hex_secret_here

# MinIO
MINIO_ROOT_PASSWORD=your_very_strong_minio_password_here

# Domain
CLIENT_URL=https://pine.evergreen-explorers.online
ALLOWED_ORIGINS=https://pine.evergreen-explorers.online
```

**Generate secrets:**

```bash
openssl rand -hex 32
```

Run it 3 times and use the output for `JWT_SECRET`, `JWT_REFRESH_SECRET`, and `POSTGRES_PASSWORD`.

## Step 4 — Build and start

```bash
cd ~/pine
docker compose --env-file infra/.env -f infra/docker-compose.server.yml up -d --build
```

This starts:
- PostgreSQL (port 5432, localhost only)
- Redis (port 6379, localhost only)
- MinIO (port 9000, localhost only)
- API server (port 3001, localhost only)
- Web app (port 3000, localhost only)
- Playback worker
- Media worker

**Verify:**

```bash
docker compose --env-file infra/.env -f infra/docker-compose.server.yml ps
curl http://127.0.0.1:3001/api/health/ready
curl http://127.0.0.1:3000
```

## Step 5 — Configure system Nginx

Copy the provided config:

```bash
sudo cp ~/pine/infra/nginx/pine-server.conf /etc/nginx/sites-available/pine
sudo ln -sf /etc/nginx/sites-available/pine /etc/nginx/sites-enabled/pine

# Remove default site if it conflicts
sudo rm -f /etc/nginx/sites-enabled/default
```

**Test and reload:**

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Step 6 — HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d pine.evergreen-explorers.online
```

Follow the prompts. Certbot will automatically update the Nginx config with SSL.

**Auto-renewal test:**

```bash
sudo certbot renew --dry-run
```

## Step 7 — Verify

Open in browser:
- `https://pine.evergreen-explorers.online` — PINE web app
- `https://pine.evergreen-explorers.online/api/health/ready` — API health

## Step 8 — Create first station

1. Register at `https://pine.evergreen-explorers.online/register`
2. Create a station in the dashboard
3. Upload a track
4. Start listening!

## Updates / Redeploy

```bash
cd ~/pine
git fetch origin
git checkout main
git pull --ff-only origin main

docker compose --env-file infra/.env -f infra/docker-compose.server.yml up -d --build
```

## Stop / Start

```bash
# Stop all
cd ~/pine
docker compose --env-file infra/.env -f infra/docker-compose.server.yml down

# Start
docker compose --env-file infra/.env -f infra/docker-compose.server.yml up -d

# Restart one service
docker compose --env-file infra/.env -f infra/docker-compose.server.yml restart api
```

## Logs

```bash
# All logs
docker compose --env-file infra/.env -f infra/docker-compose.server.yml logs -f

# API only
docker compose --env-file infra/.env -f infra/docker-compose.server.yml logs -f api

# Web only
docker compose --env-file infra/.env -f infra/docker-compose.server.yml logs -f web
```

## Backup

**Database:**

```bash
docker exec pine-v2-postgres-1 pg_dump -U pine pine > ~/pine-backup-$(date +%F).sql
```

**MinIO data:**

```bash
sudo tar czf ~/minio-backup-$(date +%F).tar.gz /var/lib/docker/volumes/pine-v2_minio_data/_data
```

## Optional: Enable Direct Media (scale optimization)

By default, audio streams go through the API (NestJS). For 1000+ listeners, enable **direct media delivery** from MinIO:

1. Open MinIO port in firewall:

```bash
sudo ufw allow 9000/tcp
```

2. Update `infra/.env`:

```env
MEDIA_DIRECT_URLS_ENABLED=1
MEDIA_DIRECT_REQUIRED=1
MINIO_PUBLIC_ENDPOINT=https://pine.evergreen-explorers.online:9000
```

3. Rebuild and restart:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.server.yml up -d --build
```

> **Note:** For HTTPS on MinIO port 9000, you need either a separate certificate or a CDN (CloudFlare, CloudFront) in front of MinIO.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "502 Bad Gateway" | Check if web/api containers are running: `docker compose ps` |
| No sound | Check `api` logs and `media-worker` logs (transcodes) |
| Upload fails | Check `client_max_body_size` in nginx config |
| CORS errors | Verify `ALLOWED_ORIGINS` matches your domain in `infra/.env` |
| SSL error | Run `sudo certbot renew` or check `sudo nginx -t` |
