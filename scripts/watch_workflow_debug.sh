#!/usr/bin/env bash
set -euo pipefail

INTERVAL_SECS="${INTERVAL_SECS:-2}"
LIMIT="${LIMIT:-10}"

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

while true; do
  clear || true
  echo "=== workflow debug view === $(date)"
  set +e
  raw="$(npx convex run llmSimulation:debugPoolView "{\"limit\":$LIMIT}" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    echo "convex run failed (rc=$rc)"
    echo "$raw"
    sleep "$INTERVAL_SECS"
    continue
  fi
  if ! json="$(printf '%s' "$raw" | json_last)"; then
    echo "no json in convex output"
    echo "$raw"
    sleep "$INTERVAL_SECS"
    continue
  fi
  python3 -c '
import json, sys
d = json.load(sys.stdin)
print("pending_total={} workflow_running={} workflow_done={}".format(
    d["pendingTotal"], d["workflowRunning"], d["workflowDone"]
))
print("pending_by_slot:", ", ".join("s{}={}".format(p["slot"], p["pending"]) for p in d["pendingBySlot"]))
print("--- simulations ---")
for s in d["simulations"]:
    elapsed = s["elapsedMs"] / 1000.0
    print("{} mode={} status={} elapsed={:.1f}s outline={} sections={}".format(
        s["id"], s["mode"], s["status"], elapsed, s["outlineCount"], s["sectionCount"]
    ))
' <<< "$json"
  sleep "$INTERVAL_SECS"
done
