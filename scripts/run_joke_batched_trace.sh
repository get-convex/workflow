#!/usr/bin/env bash
set -euo pipefail

COUNT="${COUNT:-100}"
DEBUG_TRACE="${DEBUG_TRACE:-false}"
POLL_SECS="${POLL_SECS:-2}"
TIMEOUT_SECS="${TIMEOUT_SECS:-3600}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="benchmark_results"
mkdir -p "$OUT_DIR"

LOG_RAW="$OUT_DIR/batched_${COUNT}_logs_${STAMP}.txt"
STATUS_LOG="$OUT_DIR/batched_${COUNT}_status_${STAMP}.txt"
STATUS_JSON="$OUT_DIR/batched_${COUNT}_status_${STAMP}.json"
TIMELINE_JSON="$OUT_DIR/batched_${COUNT}_timeline_${STAMP}.json"

echo "Starting trace stream before benchmark..."
npx convex logs --success \
  | rg -n "TRACE workflow\\.(step|mutation|pool)|TRACE workpool\\.|jokeBattle:" -S \
  > "$LOG_RAW" &
LOG_PID=$!

cleanup() {
  kill "$LOG_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "debugTrace=$DEBUG_TRACE count=$COUNT"
start_out="$(npx convex run jokeBattle:startBattleBenchmark "{\"mode\":\"batched\",\"count\":$COUNT,\"debugTrace\":$DEBUG_TRACE}")"
run_id="$(echo "$start_out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')"
echo "run_id=$run_id"
echo "$start_out" > "$STATUS_LOG"

started_epoch="$(date +%s)"
while true; do
  st="$(npx convex run jokeBattle:battleStatus "{\"runId\":\"$run_id\"}")"
  echo "$st" >> "$STATUS_LOG"
  status="$(echo "$st" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
  elapsed_ms="$(echo "$st" | python3 -c 'import json,sys; print(json.load(sys.stdin)["elapsedMs"])')"
  now="$(date +%s)"
  wall="$((now-started_epoch))"
  echo "t=${wall}s status=${status} elapsed_ms=${elapsed_ms}"
  if [[ "$status" != "running" ]]; then
    echo "$st" > "$STATUS_JSON"
    npx convex run jokeBattle:debugCompareTimeline "{\"count\":$COUNT}" > "$TIMELINE_JSON"
    echo "complete run_id=$run_id status=$status elapsed_ms=$elapsed_ms"
    echo "status_log=$STATUS_LOG"
    echo "status_json=$STATUS_JSON"
    echo "timeline_json=$TIMELINE_JSON"
    echo "trace_log=$LOG_RAW"
    break
  fi
  if [[ "$wall" -ge "$TIMEOUT_SECS" ]]; then
    echo "timeout run_id=$run_id"
    break
  fi
  sleep "$POLL_SECS"
done
