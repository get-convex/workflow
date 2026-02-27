# Executor Performance Tuning

## Architecture

The executor model uses sharded long-running actions that poll a task queue.
Each shard runs one executor action with bounded concurrency. The flow per step:

1. **Claim** — executor polls `claimTasks` (read-only query)
2. **Execute** — runs the step handler (action/query/mutation) with retry
3. **Buffer** — result pushed to in-memory `pendingResults`
4. **Flush** — periodic loop sends batches via `recordResultBatch` (mutation)
5. **Replay** — `replayBatchIfReady` runs workflow mutations for completed workflows
6. **Enqueue** — replay creates new tasks in `taskQueue` for the next step

Steps 4-5 are serialized per executor: flush a batch, replay its candidates, then
flush the next batch. This eliminates OCC conflicts from concurrent mutations on
the same workflow data.

## Current Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `NUM_SHARDS` | 100 | Number of executor shards (set at workflow manager level) |
| `CLAIM_LIMIT` | 1500 | Max tasks claimed per poll cycle |
| `MAX_CONCURRENCY` | 500 | Max parallel task executions per shard |
| `FLUSH_INTERVAL_MS` | 25 | How often the flush loop wakes up |
| `FLUSH_BATCH_SIZE` | 200 | Max results per `recordResultBatch` call |
| `POLL_BACKOFF_MS` | 500 | Sleep between polls when idle |
| `POLL_BACKOFF_ACTIVE_MS` | 100 | Sleep between polls when tasks are active |

## Benchmark Results (simulated 8-12s LLM steps, 4-step pipeline)

### 1k workflows
- p50: 32.8s, p99: 36.9s, slowest: 37.4s
- Queue wait max: 2.0s, inter-step gap max: 3.4s
- Near theoretical minimum (~30s with parallel analyze-a/b)

### 20k workflows
- p50: 68.8s, p90: 76.4s, p99: 81.7s, slowest: 88.4s
- Queue wait max: 19.2s (initial flood), inter-step gap max: 6.3s
- 0 failures

### 100k workflows
- Wall clock: ~693s (11.6 min), 0 failures
- Throughput: ~144 workflows/s, ~577 steps/s
- Batch creation is the bottleneck (~643s to create all 100k workflows)
- Per-workflow duration after creation: 43-50s

## Where Time Goes

### Write delay (white bars in viz)
The dominant overhead at scale. This is the gap between when the executor finishes
executing a step and when `recordResultBatch` commits the result to the DB.

**Cause**: Results sit in `pendingResults` waiting for the flush loop. Each flush
cycle takes:
- `FLUSH_INTERVAL_MS` wait (25ms)
- `recordResultBatch` RPC (~50-150ms)
- `replayBatchIfReady` RPC (~50-300ms, depends on candidate count)
- Total: ~125-475ms per cycle, draining `FLUSH_BATCH_SIZE` items

At 100k with 100 shards: each shard has ~1000 workflows. With `MAX_CONCURRENCY=500`,
up to 500 results can pile up simultaneously. Draining 500 items at batch=200 takes
~3 cycles × ~300ms = ~900ms of write delay per step wave.

### Queue wait (dim colored bars in viz)
Time between task insertion in `taskQueue` and executor claiming it. At 20k this is
~19s for the first step because 20k extract tasks all land simultaneously across
100 shards (200 per shard, but flush serialization means they're processed in waves).

### Inter-step gap
Time between step N completing (DB write) and step N+1 starting (task claimed).
This includes replay time (running the workflow mutation to discover and enqueue
the next step). With serialized replay, this is tight (1-6s at 20k).

## Knobs to Experiment With at 100k

### FLUSH_BATCH_SIZE (currently 200)
**Try: 500**
- Fewer RPC round trips, bigger mutations
- Risk: larger mutations take longer, may hit Convex mutation size/time limits
- Expected: reduces flush cycles from ~3 to ~1 per burst, cutting write delay ~3x

### FLUSH_INTERVAL_MS (currently 25)
**Try: 10 or 0**
- Less idle time between flush cycles
- Risk: none significant — flush is no-op when buffer is empty
- Expected: marginal improvement, ~15ms saved per cycle

### MAX_CONCURRENCY (currently 500)
**Try: 200**
- Fewer results pile up simultaneously → smaller write delay bursts
- Risk: lower throughput per shard, may need more shards to compensate
- Expected: write delay per step drops but overall throughput may decrease

### CLAIM_LIMIT (currently 1500)
**Try: 500**
- Claim fewer tasks per poll → less overwhelming initial burst
- Risk: more poll cycles needed, marginal latency increase
- Expected: smoother task distribution, less bursty write delay

### NUM_SHARDS (currently 100)
**Try: 200**
- More parallelism, fewer workflows per shard
- Risk: more executor actions running (cost), more concurrent mutations
- At 100k: 500 workflows/shard vs 1000 → halves per-shard load

### replayBatchIfReady mutation size
Currently all candidates from a flush batch go into one replay call. If a batch
of 200 results spans 150 unique workflows, that's 150 workflow mutations in one
call. This is the heaviest part of the flush cycle.

**Try: cap replay batch at 50 candidates, overflow to next cycle**
- Keeps replay mutations fast
- Remaining candidates replay in the next flush cycle

## Failed Experiments

### Non-blocking replay (fire-and-forget)
Decoupled flush from replay — flush immediately, replay in background.
- 1k: identical performance
- 20k: **much worse** — p50=78.8s (vs 68.8s), gap max=47s (vs 6.3s)
- Cause: 100 executors all firing `replayBatchIfReady` concurrently causes OCC
  storm between replay mutations that touch overlapping workflow data

### Individual replayIfReady per candidate
N sequential mutations per flush batch instead of one batched call.
- Much slower: N × ~100ms per candidate, blocking next flush for seconds
- Led to first implementation of `replayBatchIfReady`

### replayInline inside recordResultBatch
Replay logic ran inside the same mutation that records results.
- Reads `inProgress` index → widens OCC read set → cross-shard conflicts
- Root cause of logarithmic throughput degradation at scale
- Previous 100k run: 112 minutes (vs 11.6 min with current approach)
