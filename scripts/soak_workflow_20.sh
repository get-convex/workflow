#!/usr/bin/env bash
set -euo pipefail

RUNS="${RUNS:-20}"
MODE="${MODE:-batched}" # batched | regular
SECTION_COUNT="${SECTION_COUNT:-2000}"
TOPIC_PREFIX="${TOPIC_PREFIX:-workflow-soak}"
POLL_SECS="${POLL_SECS:-2}"
TIMEOUT_SECS="${TIMEOUT_SECS:-1800}"

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

json_field() {
  local field="$1"
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['$field'])"
}

echo "=== workflow soak ==="
echo "runs=$RUNS mode=$MODE section_count=$SECTION_COUNT"

run_secs=()
failures=0

for ((i=1; i<=RUNS; i++)); do
  echo "=== run $i/$RUNS ==="
  run_convex llmSimulation:clearAll "{}" >/dev/null
  start_out="$(run_convex llmSimulation:startPipelineForBenchmark "{\"mode\":\"$MODE\",\"topic\":\"$TOPIC_PREFIX-$i\",\"sectionCount\":$SECTION_COUNT}")"
  simulation_id="$(echo "$start_out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["simulationId"])')"
  echo "simulationId=$simulation_id"

  started_epoch="$(date +%s)"
  done=0
  while true; do
    st="$(run_convex llmSimulation:benchmarkStatus "{\"simulationId\":\"$simulation_id\"}")"
    status="$(echo "$st" | json_field status)"
    elapsed_ms="$(echo "$st" | json_field elapsedMs)"
    section_count="$(echo "$st" | json_field sectionCount)"
    outline_count="$(echo "$st" | json_field outlineCount)"
    elapsed_s="$(( $(date +%s) - started_epoch ))"
    echo "t=${elapsed_s}s status=$status outline=$outline_count sections=$section_count elapsed_ms=$elapsed_ms"
    if [[ "$status" != "running" ]]; then
      run_secs+=("$elapsed_s")
      if [[ "$status" != "completed" ]]; then
        failures=$((failures + 1))
      fi
      done=1
      break
    fi
    if [[ "$elapsed_s" -ge "$TIMEOUT_SECS" ]]; then
      echo "timeout run=$i"
      run_secs+=("$elapsed_s")
      failures=$((failures + 1))
      done=1
      break
    fi
    sleep "$POLL_SECS"
  done
  [[ "$done" -eq 1 ]] || failures=$((failures + 1))
done

python3 - <<'PY' "${run_secs[@]}" "$failures"
import statistics, sys
vals = [float(x) for x in sys.argv[1:-1]] if len(sys.argv) > 2 else []
fails = int(sys.argv[-1]) if len(sys.argv) > 1 else 0
def pct(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    idx = max(0, min(len(s)-1, int(round((len(s)-1)*q))))
    return s[idx]
print("=== workflow soak summary ===")
print(f"runs={len(vals)} failures={fails}")
if vals:
    print(f"duration_s min={min(vals):.1f} p50={pct(vals,0.5):.1f} p90={pct(vals,0.9):.1f} p95={pct(vals,0.95):.1f} max={max(vals):.1f} mean={statistics.mean(vals):.2f}")
PY

if [[ "$failures" -gt 0 ]]; then
  echo "SOAK_RESULT=FAIL"
  exit 2
fi
echo "SOAK_RESULT=PASS"
