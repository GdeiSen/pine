#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$HOME/pine}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
CHECK_INTERVAL="${CHECK_INTERVAL:-60}"
API_PORT="${API_PORT:-3101}"
WEB_PORT="${WEB_PORT:-3100}"
SERVER_ENV="${SERVER_ENV:-production}"
WEB_ENV="${WEB_ENV:-production}"

LOG_DIR="${LOG_DIR:-$APP_DIR/logs}"
DEPLOY_LOG="${DEPLOY_LOG:-$LOG_DIR/autodeploy.log}"
LOCK_FILE="${LOCK_FILE:-$LOG_DIR/autodeploy.lock}"
SERVER_PID_FILE="$LOG_DIR/server.pid"
WEB_PID_FILE="$LOG_DIR/web.pid"
SERVER_LOG="$LOG_DIR/server.log"
WEB_LOG="$LOG_DIR/web.log"

mkdir -p "$LOG_DIR"
touch "$DEPLOY_LOG"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Autodeploy is already running: $LOCK_FILE"
  exit 1
fi

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$DEPLOY_LOG"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "ERROR: missing command '$1'"
    exit 1
  fi
}

stop_process_by_pid_file() {
  local pid_file="$1"
  local name="$2"

  if [[ ! -f "$pid_file" ]]; then
    return
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  rm -f "$pid_file"

  if [[ -z "${pid:-}" ]]; then
    return
  fi

  if kill -0 "$pid" 2>/dev/null; then
    log "Stopping $name (pid=$pid)"
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
}

stop_existing_processes() {
  log "Stopping previous processes"
  stop_process_by_pid_file "$SERVER_PID_FILE" "server"
  stop_process_by_pid_file "$WEB_PID_FILE" "web"
  fuser -k "${API_PORT}/tcp" >/dev/null 2>&1 || true
  fuser -k "${WEB_PORT}/tcp" >/dev/null 2>&1 || true
}

start_processes() {
  log "Starting server on :$API_PORT"
  cd "$APP_DIR/apps/server"
  nohup env NODE_ENV="$SERVER_ENV" PORT="$API_PORT" pnpm dev >>"$SERVER_LOG" 2>&1 &
  echo "$!" >"$SERVER_PID_FILE"

  log "Starting web on :$WEB_PORT"
  cd "$APP_DIR/apps/web"
  nohup env NODE_ENV="$WEB_ENV" pnpm start -p "$WEB_PORT" -H 127.0.0.1 >>"$WEB_LOG" 2>&1 &
  echo "$!" >"$WEB_PID_FILE"

  cd "$APP_DIR"
  sleep 2

  if ! kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
    log "ERROR: server exited right after start. See $SERVER_LOG"
    return 1
  fi
  if ! kill -0 "$(cat "$WEB_PID_FILE")" 2>/dev/null; then
    log "ERROR: web exited right after start. See $WEB_LOG"
    return 1
  fi

  log "Started server pid=$(cat "$SERVER_PID_FILE"), web pid=$(cat "$WEB_PID_FILE")"
}

ensure_running() {
  local missing=0

  if [[ ! -f "$SERVER_PID_FILE" ]] || ! kill -0 "$(cat "$SERVER_PID_FILE" 2>/dev/null)" 2>/dev/null; then
    missing=1
  fi
  if [[ ! -f "$WEB_PID_FILE" ]] || ! kill -0 "$(cat "$WEB_PID_FILE" 2>/dev/null)" 2>/dev/null; then
    missing=1
  fi

  if (( missing )); then
    log "Processes are not running. Starting current revision."
    stop_existing_processes
    start_processes
  fi
}

deploy_if_needed() {
  cd "$APP_DIR"

  if [[ -n "$(git status --porcelain)" ]]; then
    log "Working tree is not clean. Skipping deploy to avoid overwriting local changes."
    return 0
  fi

  git fetch "$REMOTE" "$BRANCH" --prune >>"$DEPLOY_LOG" 2>&1

  local local_sha remote_sha
  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "$REMOTE/$BRANCH")"

  if [[ "$local_sha" == "$remote_sha" ]]; then
    log "No updates on $REMOTE/$BRANCH"
    return 0
  fi

  log "Update detected: $local_sha -> $remote_sha"
  git checkout "$BRANCH" >>"$DEPLOY_LOG" 2>&1
  git pull --ff-only "$REMOTE" "$BRANCH" >>"$DEPLOY_LOG" 2>&1

  log "Installing dependencies"
  pnpm install --frozen-lockfile >>"$DEPLOY_LOG" 2>&1

  log "Running Prisma generate"
  pnpm --filter @web-radio/server exec prisma generate >>"$DEPLOY_LOG" 2>&1

  log "Running Prisma migrate deploy"
  pnpm --filter @web-radio/server exec prisma migrate deploy >>"$DEPLOY_LOG" 2>&1

  log "Building"
  pnpm build >>"$DEPLOY_LOG" 2>&1

  stop_existing_processes
  start_processes
  log "Deploy completed at commit $(git rev-parse --short HEAD)"
}

require_cmd git
require_cmd pnpm
require_cmd fuser
require_cmd nohup
require_cmd flock

if [[ ! -d "$APP_DIR/.git" ]]; then
  log "ERROR: APP_DIR does not look like a git repository: $APP_DIR"
  exit 1
fi

log "Watcher started (repo=$APP_DIR, branch=$REMOTE/$BRANCH, interval=${CHECK_INTERVAL}s)"
ensure_running

while true; do
  if ! deploy_if_needed; then
    log "Deploy attempt failed. Will retry in ${CHECK_INTERVAL}s."
  fi
  sleep "$CHECK_INTERVAL"
done
