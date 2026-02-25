import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/benchmark-viz",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(BENCHMARK_VIZ_HTML, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      },
    });
  }),
});

export default http;

const BENCHMARK_VIZ_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Benchmark Timeline</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #111; color: #eee; font-family: monospace; }
  #header {
    position: fixed; top: 0; left: 0; right: 0; z-index: 10;
    background: #111; border-bottom: 1px solid #333; padding: 8px 16px;
  }
  #stats { font-size: 14px; margin-bottom: 4px; }
  #stats span { margin-right: 16px; }
  #timescale-container { height: 24px; position: relative; overflow: hidden; }
  #timescale { height: 24px; }
  #phase-graph-container {
    position: relative;
    margin-top: 100px;
    height: 150px;
    border-bottom: 1px solid #333;
  }
  canvas#phaseGraph { display: block; width: 100%; height: 150px; }
  #phase-graph-container .y-label {
    position: absolute; right: 4px; color: rgba(255,255,255,0.5);
    font: 10px monospace; pointer-events: none;
  }
  #canvas-container {
    position: relative;
    overflow-y: auto; overflow-x: hidden;
    height: calc(100vh - 250px);
  }
  canvas#timeline { display: block; transform-origin: top left; }
  canvas#timescale { display: block; }
  .stat-total { color: #fff; }
  .stat-running { color: #4af; }
  .stat-completed { color: #4f4; }
  .stat-failed { color: #f44; }
  #legend { display: inline-block; margin-left: 32px; font-size: 12px; }
  #legend span { margin-right: 12px; }
  .c-extract { color: rgba(68,136,255,0.9); }
  .c-analyze-a { color: rgba(80,220,120,0.9); }
  .c-analyze-b { color: rgba(255,180,40,0.9); }
  .c-summarize { color: rgba(255,68,68,0.9); }
</style>
</head>
<body>
<div id="header">
  <div id="stats">
    <span class="stat-total">Total: <b id="s-total">-</b></span>
    <span class="stat-running">Running: <b id="s-running">-</b></span>
    <span class="stat-completed">Completed: <b id="s-completed">-</b></span>
    <span class="stat-failed">Failed: <b id="s-failed">-</b></span>
    <span id="elapsed" style="color:#888"></span>
    <div id="legend">
      <span class="c-extract">■ extract</span>
      <span class="c-analyze-a">■ analyze-a</span>
      <span class="c-analyze-b">■ analyze-b</span>
      <span class="c-summarize">■ summarize</span>
      <span style="color:#666; margin-left:8px">│</span>
      <span style="color:#555">░ queued</span>
      <span style="color:#aaa">█ executing</span>
      <span style="color:rgba(255,255,255,0.6)">█ write delay</span>
    </div>
  </div>
  <canvas id="timescale" height="24"></canvas>
</div>
<div id="phase-graph-container">
  <canvas id="phaseGraph"></canvas>
</div>
<div id="canvas-container">
  <canvas id="timeline"></canvas>
</div>

<script type="module">
// HTTP actions are on .convex.site, but API queries live on .convex.cloud
const CONVEX_URL = window.location.origin.replace(".convex.site", ".convex.cloud");

// ── Step color by stepNumber ──
// 0=extract, 1=analyze-a, 2=analyze-b, 3=summarize
const STEP_COLORS = [
  { full: "rgba(68,136,255,0.7)",  queued: "rgba(68,136,255,0.2)" },
  { full: "rgba(80,220,120,0.45)", queued: "rgba(80,220,120,0.12)" },
  { full: "rgba(255,180,40,0.45)", queued: "rgba(255,180,40,0.12)" },
  { full: "rgba(255,68,68,0.7)",   queued: "rgba(255,68,68,0.2)" },
];
function stepColor(stepNumber) {
  return (STEP_COLORS[stepNumber] || { full: "#888", queued: "#333" }).full;
}
function stepQueuedColor(stepNumber) {
  return (STEP_COLORS[stepNumber] || { full: "#888", queued: "#333" }).queued;
}

// ── Parse ?after= from URL (required) ──
const params = new URLSearchParams(window.location.search);
if (!params.has("after")) {
  document.body.innerHTML = '<div style="padding:40px;font-family:monospace;color:#eee;background:#111;height:100vh">'
    + '<h2>Missing ?after= parameter</h2>'
    + '<p>Run a benchmark and use the returned startedAt timestamp:</p>'
    + '<pre style="color:#4f4">npx convex run benchmark:startBenchmark &#39;{"mode":"executor","count":1000}&#39;</pre>'
    + '<p>Then visit:</p>'
    + '<pre style="color:#4af">' + window.location.origin + '/benchmark-viz?after=&lt;startedAt&gt;</pre>'
    + '</div>';
  throw new Error("Missing ?after= parameter");
}
const createdAfter = Number(params.get("after"));

// ── Shard hash (matches server-side shardForWorkflow) ──
const NUM_SHARDS = 100;
function shardForId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return ((hash % NUM_SHARDS) + NUM_SHARDS) % NUM_SHARDS;
}
const sortByShard = params.get("sort") === "shard";

// ── State ──
const WF_NAME = "benchmark:executorResearchWorkflow";
const ROW_H = 1;
const LABEL_EVERY = 1000;
let allWorkflows = [];
let benchmarkStart = Infinity;
let timeSpanMs = 1;
let latestStatus = { total: 0, completed: 0, failed: 0, running: 0 };

// ── Canvas setup ──
const timeCanvas = document.getElementById("timescale");
const timeCtx = timeCanvas.getContext("2d");
const phaseCanvas = document.getElementById("phaseGraph");
const phaseCtx = phaseCanvas.getContext("2d");
const canvas = document.getElementById("timeline");
const ctx = canvas.getContext("2d");

function resize() {
  const w = window.innerWidth;
  timeCanvas.width = w;
  phaseCanvas.width = w;
  phaseCanvas.height = 150;
  canvas.width = w;
}
window.addEventListener("resize", () => { resize(); draw(); });
resize();

// ── Paginated status polling (avoids 16MB read limit at 20k+ workflows) ──
async function fetchStatusPages() {
  let completed = 0, failed = 0, running = 0;
  let cursor = null;
  let isDone = false;
  while (!isDone) {
    const page = await fetchQuery(CONVEX_URL, "benchmark:benchmarkStatusPage", {
      name: WF_NAME, createdAfter, paginationOpts: { cursor, numItems: 1000 },
    });
    completed += page.completed;
    failed += page.failed;
    running += page.running;
    cursor = page.continueCursor;
    isDone = page.isDone;
  }
  const total = completed + failed + running;
  latestStatus = { total, completed, failed, running };
  document.getElementById("s-total").textContent = total;
  document.getElementById("s-running").textContent = running;
  document.getElementById("s-completed").textContent = completed;
  document.getElementById("s-failed").textContent = failed;
}

// Poll status every 2s (backs off on errors)
(async function pollStatus() {
  let backoff = 2000;
  while (true) {
    try { await fetchStatusPages(); backoff = 2000; } catch (e) { console.error("Status poll error:", e); backoff = Math.min(backoff * 2, 30000); }
    await new Promise(r => setTimeout(r, backoff));
  }
})();

// ── Query helper ──
async function fetchQuery(url, fnName, args) {
  const resp = await fetch(url + "/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fnName, args, format: "json" }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  const json = await resp.json();
  if (json.status === "error") throw new Error(json.errorMessage);
  return json.value;
}

function rebuildAndDraw() {
  if (sortByShard) {
    allWorkflows.sort((a, b) => {
      const sa = shardForId(a.id), sb = shardForId(b.id);
      return sa !== sb ? sa - sb : a.createdAt - b.createdAt;
    });
  } else {
    allWorkflows.sort((a, b) => a.createdAt - b.createdAt);
  }

  if (allWorkflows.length > 0) {
    benchmarkStart = allWorkflows[0].createdAt;
    let latest = benchmarkStart;
    for (const wf of allWorkflows) {
      for (const s of wf.steps) {
        if (s.completedAt && s.completedAt > latest) latest = s.completedAt;
        if (s.startedAt > latest) latest = s.startedAt;
      }
    }
    if (latestStatus.running > 0) latest = Math.max(latest, Date.now());
    timeSpanMs = Math.max(latest - benchmarkStart, 1);
  }

  document.getElementById("elapsed").textContent =
    "Span: " + (timeSpanMs / 1000).toFixed(1) + "s  |  " + allWorkflows.length + " workflows";
  draw();
}

// Stream pages incrementally — draw after each page arrives.
// Keep previous data visible until incoming count exceeds it.
const PAGE_SIZE = 500;
const PAGES_PER_DRAW = 8; // fetch 8 pages (4000 workflows) before redrawing

async function fetchAndDrawAllPages() {
  const prev = allWorkflows;
  const incoming = [];
  let cursor = null;
  let isDone = false;

  while (!isDone) {
    // Fetch PAGES_PER_DRAW pages before redrawing to minimize draw overhead
    for (let p = 0; p < PAGES_PER_DRAW && !isDone; p++) {
      const result = await fetchQuery(CONVEX_URL, "benchmark:benchmarkTimeline", {
        name: WF_NAME,
        createdAfter,
        paginationOpts: { cursor, numItems: PAGE_SIZE },
      });
      incoming.push(...result.page);
      cursor = result.continueCursor;
      isDone = result.isDone;
    }
    if (incoming.length >= prev.length) {
      allWorkflows = incoming;
      rebuildAndDraw();
    }
  }
  allWorkflows = incoming;
  rebuildAndDraw();
}

// Poll timeline every 3s (backs off on errors)
(async function pollTimeline() {
  let backoff = 3000;
  while (true) {
    try {
      await fetchAndDrawAllPages();
      backoff = 3000;
    } catch (e) {
      console.error("Timeline poll error:", e);
      backoff = Math.min(backoff * 2, 30000);
    }
    await new Promise(r => setTimeout(r, backoff));
  }
})();

// ── Drawing ──
function draw() {
  const W = canvas.width;
  const containerH = window.innerHeight - 60;
  const n = allWorkflows.length || 1;

  // Render at 1px per row, CSS-scale only the Y axis to fit viewport.
  // Cap at 32768 to avoid browser canvas size limits.
  canvas.height = Math.min(Math.max(n, 100), 32768);
  canvas.style.width = W + "px";
  canvas.style.height = containerH + "px";
  canvas.style.imageRendering = n > containerH ? "auto" : "pixelated";

  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, W, canvas.height);

  const rowScale = canvas.height / n;
  for (let i = 0; i < allWorkflows.length; i++) {
    const wf = allWorkflows[i];
    const y = Math.floor(i * rowScale);

    for (const step of wf.steps) {
      const x0 = ((step.startedAt - benchmarkStart) / timeSpanMs) * W;
      const endT = step.completedAt || Date.now();
      const x1 = ((endT - benchmarkStart) / timeSpanMs) * W;

      if (step.executionStartedAt && step.executionStartedAt > step.startedAt) {
        // Queued portion (dim)
        const xExec = ((step.executionStartedAt - benchmarkStart) / timeSpanMs) * W;
        ctx.fillStyle = stepQueuedColor(step.stepNumber);
        ctx.fillRect(x0, y, Math.max(xExec - x0, 1), 1);
        // Execution portion (bright) — ends at executorFinishedAt if available
        const execEnd = step.executorFinishedAt || endT;
        const xExecEnd = ((execEnd - benchmarkStart) / timeSpanMs) * W;
        ctx.fillStyle = stepColor(step.stepNumber);
        ctx.fillRect(xExec, y, Math.max(xExecEnd - xExec, 1), 1);
        // Write delay (white) — gap between executor finish and DB write
        if (step.executorFinishedAt && step.completedAt && step.completedAt > step.executorFinishedAt) {
          const xWriteStart = ((step.executorFinishedAt - benchmarkStart) / timeSpanMs) * W;
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.fillRect(xWriteStart, y, Math.max(x1 - xWriteStart, 1), 1);
        }
      } else {
        // No queue info — full bar
        ctx.fillStyle = stepColor(step.stepNumber);
        ctx.fillRect(x0, y, Math.max(x1 - x0, 1), 1);
      }
    }
  }

  // Remove old label overlays
  document.querySelectorAll(".row-label").forEach(el => el.remove());
  const container = document.getElementById("canvas-container");
  const scaleY = containerH / n;

  if (sortByShard) {
    // Draw shard separators and labels
    let prevShard = -1;
    for (let i = 0; i < allWorkflows.length; i++) {
      const s = shardForId(allWorkflows[i].id);
      if (s !== prevShard && prevShard !== -1) {
        const yLine = Math.floor(i * rowScale);
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.fillRect(0, yLine, W, 1);
        const el = document.createElement("div");
        el.className = "row-label";
        el.textContent = "s" + s;
        el.style.cssText = "position:absolute;left:4px;top:" + (i * scaleY) + "px;"
          + "color:rgba(255,200,100,0.9);font:11px monospace;pointer-events:none;"
          + "background:rgba(17,17,17,0.8);padding:0 4px;line-height:16px;z-index:2;";
        container.appendChild(el);
      }
      prevShard = s;
    }
  } else {
    // Row-count labels
    const labelEvery = n > 5000 ? 5000 : n > 500 ? 1000 : n > 50 ? 100 : 10;
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    for (let m = labelEvery; m < allWorkflows.length; m += labelEvery) {
      ctx.fillRect(0, Math.floor(m * rowScale), W, 1);
    }
    for (let m = labelEvery; m < allWorkflows.length; m += labelEvery) {
      const el = document.createElement("div");
      el.className = "row-label";
      el.textContent = m.toLocaleString();
      el.style.cssText = "position:absolute;left:4px;top:" + (m * scaleY) + "px;"
        + "color:rgba(255,255,255,0.8);font:11px monospace;pointer-events:none;"
        + "background:rgba(17,17,17,0.8);padding:0 4px;line-height:16px;z-index:2;";
      container.appendChild(el);
    }
  }

  drawTimescale(W);
  drawPhaseGraph(W);
}

// ── Phase concurrency graph ──
// Stacked area chart: for each time bucket, count workflows executing each phase.
const PHASE_COLORS = [
  "rgba(68,136,255,0.8)",   // extract
  "rgba(80,220,120,0.8)",   // analyze-a
  "rgba(255,180,40,0.8)",   // analyze-b
  "rgba(255,68,68,0.8)",    // summarize
];
const PHASE_FILLS = [
  "rgba(68,136,255,0.3)",
  "rgba(80,220,120,0.3)",
  "rgba(255,180,40,0.3)",
  "rgba(255,68,68,0.3)",
];

function drawPhaseGraph(W) {
  const H = phaseCanvas.height;
  phaseCtx.fillStyle = "#111";
  phaseCtx.fillRect(0, 0, W, H);

  if (allWorkflows.length === 0 || timeSpanMs <= 1) return;

  // Build time buckets
  const NUM_BUCKETS = Math.min(W, 400);
  const bucketMs = timeSpanMs / NUM_BUCKETS;
  // counts[bucket][phase] = number of workflows executing that phase
  const counts = Array.from({ length: NUM_BUCKETS }, () => [0, 0, 0, 0]);

  for (const wf of allWorkflows) {
    for (const step of wf.steps) {
      const execStart = step.executionStartedAt || step.startedAt;
      const execEnd = step.executorFinishedAt || step.completedAt || Date.now();
      const phase = step.stepNumber;
      if (phase < 0 || phase > 3) continue;
      const b0 = Math.max(0, Math.floor((execStart - benchmarkStart) / bucketMs));
      const b1 = Math.min(NUM_BUCKETS - 1, Math.floor((execEnd - benchmarkStart) / bucketMs));
      for (let b = b0; b <= b1; b++) {
        counts[b][phase]++;
      }
    }
  }

  // Find max stacked total for Y scale
  let maxTotal = 0;
  for (let b = 0; b < NUM_BUCKETS; b++) {
    const sum = counts[b][0] + counts[b][1] + counts[b][2] + counts[b][3];
    if (sum > maxTotal) maxTotal = sum;
  }
  if (maxTotal === 0) return;

  const xScale = W / NUM_BUCKETS;
  const yScale = (H - 20) / maxTotal; // leave 20px top for labels

  // Draw stacked areas bottom-up: summarize, analyze-b, analyze-a, extract
  // (so extract is on top, matching the timeline left-to-right order visually)
  const phaseOrder = [3, 2, 1, 0]; // bottom to top
  for (const phase of phaseOrder) {
    phaseCtx.beginPath();
    phaseCtx.moveTo(0, H);
    for (let b = 0; b < NUM_BUCKETS; b++) {
      let stackedVal = 0;
      for (let p = 3; p >= phase; p--) {
        stackedVal += counts[b][p];
      }
      const x = b * xScale;
      const y = H - stackedVal * yScale;
      phaseCtx.lineTo(x, y);
    }
    phaseCtx.lineTo(W, H);
    phaseCtx.closePath();
    phaseCtx.fillStyle = PHASE_FILLS[phase];
    phaseCtx.fill();
    phaseCtx.strokeStyle = PHASE_COLORS[phase];
    phaseCtx.lineWidth = 1;
    phaseCtx.stroke();
  }

  // Y-axis labels
  document.querySelectorAll("#phase-graph-container .y-label").forEach(el => el.remove());
  const container = document.getElementById("phase-graph-container");
  for (const val of [maxTotal, Math.round(maxTotal / 2)]) {
    const el = document.createElement("div");
    el.className = "y-label";
    el.textContent = val.toLocaleString();
    el.style.top = (H - val * yScale - 6) + "px";
    container.appendChild(el);
  }
}

function drawTimescale(W) {
  timeCtx.fillStyle = "#111";
  timeCtx.fillRect(0, 0, W, 24);
  timeCtx.fillStyle = "#666";
  timeCtx.font = "10px monospace";

  const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let tickSec = 1;
  for (const iv of intervals) {
    if ((timeSpanMs / 1000) / iv < W / 60) { tickSec = iv; break; }
  }

  for (let t = 0; t <= timeSpanMs / 1000; t += tickSec) {
    const x = (t / (timeSpanMs / 1000)) * W;
    timeCtx.fillRect(x, 16, 1, 8);
    const label = t >= 60
      ? (t % 60 === 0 ? (t / 60) + "m" : Math.floor(t / 60) + "m" + (t % 60) + "s")
      : t + "s";
    timeCtx.fillText(label, x + 2, 14);
  }
}
</script>
</body>
</html>`;
