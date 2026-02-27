#!/usr/bin/env bash
set -euo pipefail

SECTION_COUNT="${SECTION_COUNT:-50}"
POLL_SECS="${POLL_SECS:-1}"
TIMEOUT_SECS="${TIMEOUT_SECS:-600}"
SKIP_CLEAR="${SKIP_CLEAR:-0}"

run_convex() {
  local fn="$1"
  local args
  if [[ $# -ge 2 ]]; then
    args="$2"
  else
    args="{}"
  fi
  npx convex run "$fn" "$args"
}

json_last() {
  python3 -c '
import json,sys
t=sys.stdin.read()
for i in range(len(t)-1,-1,-1):
  if t[i] != "{":
    continue
  try:
    obj=json.loads(t[i:])
    print(json.dumps(obj))
    raise SystemExit(0)
  except Exception:
    pass
raise SystemExit(1)
'
}

run_one() {
  local mode="$1"
  local topic="$2"
  if [[ "$SKIP_CLEAR" != "1" ]]; then
    run_convex llmSimulation:clearAll "{}" >/dev/null || true
    sleep 1
  fi
  start_out="$(run_convex llmSimulation:startPipelineForBenchmark "{\"mode\":\"$mode\",\"topic\":\"$topic\",\"sectionCount\":$SECTION_COUNT}")"
  simulation_id="$(echo "$start_out" | json_last | python3 -c 'import json,sys; print(json.load(sys.stdin)["simulationId"])')"
  started_epoch="$(date +%s)"
  while true; do
    set +e
    st="$(run_convex llmSimulation:benchmarkStatus "{\"simulationId\":\"$simulation_id\"}" 2>/tmp/workflow_bench_err.log)"
    rc=$?
    set -e
    if [[ "$rc" -ne 0 ]]; then
      elapsed_s="$(( $(date +%s) - started_epoch ))"
      echo "mode=$mode t=${elapsed_s}s status=missing_simulation"
      echo "$mode,missing_simulation,0,$elapsed_s"
      return 0
    fi
    status="$(echo "$st" | json_last | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
    elapsed_ms="$(echo "$st" | json_last | python3 -c 'import json,sys; print(json.load(sys.stdin)["elapsedMs"])')"
    elapsed_s="$(( $(date +%s) - started_epoch ))"
    echo "mode=$mode t=${elapsed_s}s status=$status elapsed_ms=$elapsed_ms"
    if [[ "$status" != "running" ]]; then
      echo "$mode,$status,$elapsed_ms,$elapsed_s"
      return 0
    fi
    if [[ "$elapsed_s" -ge "$TIMEOUT_SECS" ]]; then
      echo "$mode,timeout,0,$elapsed_s"
      return 0
    fi
    sleep "$POLL_SECS"
  done
}

echo "=== workflow small benchmark ==="
echo "section_count=$SECTION_COUNT"

regular_line="$(run_one regular "small-regular" | tail -n 1)"
batched_line="$(run_one batched "small-batched" | tail -n 1)"

python3 - <<'PY' "$regular_line" "$batched_line"
import sys
r = sys.argv[1].split(",")
b = sys.argv[2].split(",")
print("=== summary ===")
print(f"regular: status={r[1]} elapsed_ms={r[2]} elapsed_s={r[3]}")
print(f"batched: status={b[1]} elapsed_ms={b[2]} elapsed_s={b[3]}")
if r[1] == "completed" and b[1] == "completed":
    r_ms = float(r[2]); b_ms = float(b[2])
    if b_ms > 0:
      print(f"speedup={r_ms / b_ms:.2f}x")
PY
