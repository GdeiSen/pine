#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost}"
STATION_CODE="${STATION_CODE:-}"
ACCESS_TOKEN="${ACCESS_TOKEN:-}"
SCENARIO="${SCENARIO:-steady}"
OUT_DIR="${OUT_DIR:-/tmp/pine-load}"

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is required. Install it first: https://k6.io/docs/get-started/installation/"
  exit 1
fi

if [ -z "$STATION_CODE" ]; then
  echo "STATION_CODE is required"
  echo "Example:"
  echo "  STATION_CODE=123456 BASE_URL=https://pine.example.com bash scripts/load/run-group-listening.sh"
  exit 1
fi

mkdir -p "$OUT_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUMMARY_FILE="$OUT_DIR/group-listening-${SCENARIO}-${TIMESTAMP}.summary.json"

echo "Running group listening load test..."
echo "BASE_URL=$BASE_URL"
echo "STATION_CODE=$STATION_CODE"
echo "SCENARIO=$SCENARIO"
echo "SUMMARY_FILE=$SUMMARY_FILE"

if [ -n "$ACCESS_TOKEN" ]; then
  k6 run scripts/load/group-listening.k6.js \
    --summary-export "$SUMMARY_FILE" \
    -e BASE_URL="$BASE_URL" \
    -e STATION_CODE="$STATION_CODE" \
    -e ACCESS_TOKEN="$ACCESS_TOKEN" \
    -e SCENARIO="$SCENARIO"
else
  k6 run scripts/load/group-listening.k6.js \
    --summary-export "$SUMMARY_FILE" \
    -e BASE_URL="$BASE_URL" \
    -e STATION_CODE="$STATION_CODE" \
    -e SCENARIO="$SCENARIO"
fi

echo "Load test finished."
echo "Summary saved to: $SUMMARY_FILE"
