const fs = require("fs");
const d = fs.readFileSync("/tmp/jokebattle_data.json", "utf8");
const j = JSON.parse(d);
const r = j.regular;
if (r == null) {
  console.log("No regular run found");
} else {
  console.log("Regular rows:", r.itemRows?.length);
  console.log("concurrency pts:", r.concurrency?.length);
  console.log("completionCurve pts:", r.completionCurve?.length);
  console.log("maxConcurrency:", r.maxConcurrency);
  console.log("status:", r.status);
  console.log("elapsedMs:", r.elapsedMs);
  const row = r.itemRows?.[0];
  if (row) {
    console.log("Row 0:", JSON.stringify(row));
  } else {
    console.log("No itemRows");
  }
}
const b = j.batched;
if (b == null) {
  console.log("\nNo batched run found");
} else {
  console.log("\nBatched rows:", b.itemRows?.length);
  const brow = b.itemRows?.[0];
  if (brow) console.log("Batched Row 0:", JSON.stringify(brow));
}
