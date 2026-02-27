#!/usr/bin/env bash
set -euo pipefail

COUNT="${COUNT:-20}"
POLL_SECS="${POLL_SECS:-3}"
TIMEOUT_SECS="${TIMEOUT_SECS:-600}"

cd "$(dirname "$0")/.."

convex_run() {
  npx convex run "$1" "$2" 2>/dev/null | tr -d '[:space:]'
}

echo "=== Workflow Benchmark: Standard vs Batch ==="
echo "Count: $COUNT workflows"
echo "Each workflow: extract -> (analyze-a || analyze-b) -> summarize (~5s each step)"
echo ""

run_mode() {
  local mode="$1"
  local name="$2"

  echo "--- Starting $mode mode ($COUNT workflows) ---"
  local start_out
  start_out="$(convex_run "benchmark:startBenchmark" "{\"mode\":\"$mode\",\"count\":$COUNT}")"
  local wall_start
  wall_start="$(date +%s)"
  echo "  Started at wall clock $(date +%H:%M:%S)"

  while true; do
    sleep "$POLL_SECS"
    local raw
    raw="$(convex_run "benchmark:benchmarkStatus" "{\"name\":\"$name\",\"expectedCount\":$COUNT}" 2>/dev/null || echo "{}")"

    # Parse JSON fields with python
    local completed failed running
    completed="$(echo "$raw" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("completed",0))' 2>/dev/null || echo 0)"
    failed="$(echo "$raw" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("failed",0))' 2>/dev/null || echo 0)"
    running="$(echo "$raw" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("running",0))' 2>/dev/null || echo 0)"

    local elapsed=$(( $(date +%s) - wall_start ))
    echo "  [${elapsed}s] completed=$completed failed=$failed running=$running"

    if [[ "$completed" -ge "$COUNT" ]] || [[ "$(( completed + failed ))" -ge "$COUNT" ]]; then
      echo "  Done: completed=$completed failed=$failed wall=${elapsed}s"
      eval "${mode}_elapsed=$elapsed"
      eval "${mode}_completed=$completed"
      eval "${mode}_failed=$failed"
      return 0
    fi

    if [[ "$elapsed" -ge "$TIMEOUT_SECS" ]]; then
      echo "  TIMEOUT after ${elapsed}s"
      eval "${mode}_elapsed=$elapsed"
      eval "${mode}_completed=$completed"
      eval "${mode}_failed=$failed"
      return 0
    fi
  done
}

standard_elapsed=0
standard_completed=0
standard_failed=0
batched_elapsed=0
batched_completed=0
batched_failed=0

run_mode "batched" "benchmark:batchedResearchWorkflow"
echo ""
run_mode "standard" "benchmark:standardResearchWorkflow"

echo ""
echo "=== RESULTS ==="
echo ""
printf "  %-12s %10s %8s %10s\n" "Mode" "Completed" "Failed" "Wall time"
printf "  %-12s %10s %8s %10s\n" "────────────" "─────────" "──────" "─────────"
printf "  %-12s %10d %8d %9ds\n" "standard" "$standard_completed" "$standard_failed" "$standard_elapsed"
printf "  %-12s %10d %8d %9ds\n" "batched" "$batched_completed" "$batched_failed" "$batched_elapsed"
echo ""

if [[ "$standard_elapsed" -gt 0 ]] && [[ "$batched_elapsed" -gt 0 ]]; then
  python3 -c "
s=$standard_elapsed; b=$batched_elapsed
if b > 0:
    ratio = s / b
    if ratio > 1:
        print(f'  Batch is {ratio:.1f}x faster than standard')
    elif ratio < 1:
        print(f'  Standard is {1/ratio:.1f}x faster than batch')
    else:
        print(f'  Both modes completed in the same time')
"
fi
