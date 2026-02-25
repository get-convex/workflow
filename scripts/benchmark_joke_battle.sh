#!/usr/bin/env bash
set -euo pipefail

COUNT="${COUNT:-500}"
POLL_SECS="${POLL_SECS:-2}"
TIMEOUT_SECS="${TIMEOUT_SECS:-7200}"

run_convex() {
  local fn="$1"
  local args="${2:-"{}"}"
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
  local start_out run_id started_epoch st status elapsed_ms elapsed_s
  start_out="$(run_convex jokeBattle:startBattleBenchmark "{\"mode\":\"$mode\",\"count\":$COUNT}")"
  run_id="$(echo "$start_out" | json_last | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')"
  echo "started mode=$mode run_id=$run_id"
  started_epoch="$(date +%s)"
  while true; do
    st="$(run_convex jokeBattle:battleStatus "{\"runId\":\"$run_id\"}")"
    status="$(echo "$st" | json_last | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
    elapsed_ms="$(echo "$st" | json_last | python3 -c 'import json,sys; print(json.load(sys.stdin)["elapsedMs"])')"
    elapsed_s="$(( $(date +%s) - started_epoch ))"
    echo "mode=$mode t=${elapsed_s}s status=$status elapsed_ms=$elapsed_ms"
    if [[ "$status" != "running" ]]; then
      echo "$mode,$status,$elapsed_ms,$elapsed_s,$run_id"
      return 0
    fi
    if [[ "$elapsed_s" -ge "$TIMEOUT_SECS" ]]; then
      echo "$mode,timeout,0,$elapsed_s,$run_id"
      return 0
    fi
    sleep "$POLL_SECS"
  done
}

echo "=== joke battle benchmark (real llm) ==="
echo "count=$COUNT"

regular_line="$(run_one regular | tail -n 1)"
batched_line="$(run_one batched | tail -n 1)"

python3 - <<'PY' "$regular_line" "$batched_line"
import sys
r = sys.argv[1].split(",")
b = sys.argv[2].split(",")
print("=== summary ===")
print(f"regular: status={r[1]} elapsed_ms={r[2]} elapsed_s={r[3]} run_id={r[4]}")
print(f"batched: status={b[1]} elapsed_ms={b[2]} elapsed_s={b[3]} run_id={b[4]}")
if r[1] == "completed" and b[1] == "completed" and float(b[2]) > 0:
    print(f"speedup={float(r[2]) / float(b[2]):.2f}x")
PY
