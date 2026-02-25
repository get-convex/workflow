import { ConvexHttpClient } from "convex/browser";

const deploymentUrl = "https://cautious-quail-607.convex.cloud";
const client = new ConvexHttpClient(deploymentUrl);

const name = "benchmark:executorResearchWorkflow";
const createdAfter = 1771983329506;

let cursor = null;
let isDone = false;
let totalScanned = 0;
const running = [];

while (!isDone) {
  const page = await client.query("benchmark:benchmarkTimeline", {
    name,
    createdAfter,
    paginationOpts: { cursor, numItems: 500 },
  });
  
  for (const wf of page.page) {
    totalScanned++;
    if (!wf.runResult) {
      running.push(wf);
    }
  }
  
  cursor = page.continueCursor;
  isDone = page.isDone;
  
  process.stderr.write(`Scanned ${totalScanned}, found ${running.length} running so far...\n`);
  
  if (running.length >= 17) break;
}

console.log(JSON.stringify({ totalScanned, runningCount: running.length, running }, null, 2));
