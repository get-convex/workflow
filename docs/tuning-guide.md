# Executor Mode Tuning Guide

This guide explains the knobs available for tuning executor-mode workflows and
how to configure them for different workload profiles.

## Quick Reference

| Knob | Default | Where | Effect |
|------|---------|-------|--------|
| `executorShards` | — | Constructor | Number of long-lived executor actions |
| `maxParallelism` | 200 | Constructor (`workpoolOptions`) | Max parallel steps across all executors |
| `CLAIM_LIMIT` | 800 | `src/client/index.ts` | Tasks read per poll per shard |
| `MAX_CONCURRENCY` | 200 | `src/client/index.ts` | Concurrent task handlers per shard |
| `FLUSH_BATCH_SIZE` | 50 | `src/client/index.ts` | Results batched per `recordResultBatch` call |
| `FLUSH_INTERVAL_MS` | 500 | `src/client/index.ts` | Flush loop frequency |
| `POLL_BACKOFF_MS` | 500 | `src/client/index.ts` | Sleep between empty polls |
| `POLL_BACKOFF_ACTIVE_MS` | 150 | `src/client/index.ts` | Sleep between polls when tasks are active |
| `RESCHEDULE_MS` | 8 min | `src/client/index.ts` | Self-reschedule before 10-min action timeout |
| Per-step `retry` | 1 attempt | `step.runAction(..., { retry })` | Retry config for individual steps |

## Constructor Options

### `executorShards`

The number of long-lived Convex actions that process tasks in parallel. Each
shard claims tasks from a non-overlapping index range, so shards don't conflict
with each other.

**How to choose:**
- More shards = more parallelism but more mutation pressure (each shard
  fires `recordResultBatch` + `replayIfReady` mutations independently).
- Aim for ~200-500 tasks per shard per step wave at peak load.
- Convex allows 512 concurrent actions per deployment. Each shard consumes one
  action slot, so leave room for other work.

| Workflow count | Recommended shards | Tasks/shard |
|----------------|-------------------|-------------|
| 100            | 10-20             | 5-10        |
| 1,000          | 20-40             | 25-50       |
| 10,000         | 40-60             | 170-250     |
| 20,000         | 80-100            | 200-250     |

```typescript
const workflow = new WorkflowManager(components.workflow, {
  executorShards: 100,
});
```

### `maxParallelism`

Limits total concurrent in-progress steps across all executors. This is a
soft limit enforced at the workflow component level.

```typescript
const workflow = new WorkflowManager(components.workflow, {
  executorShards: 100,
  workpoolOptions: { maxParallelism: 200 },
});
```

## Internal Executor Constants

These are defined inside `src/client/index.ts` in the `executor()` method.
To tune them, edit the source directly.

### `MAX_CONCURRENCY` (default: 200)

Max concurrent task handlers running simultaneously inside a single executor
shard. This bounds memory and CPU usage per action.

**Tradeoffs:**
- Higher = more throughput per shard, but each handler holds state (promise,
  pending result) in memory. At 200 concurrent tasks × 100 shards = 20,000
  total concurrent handlers.
- For CPU-light work (LLM API calls that mostly wait on network), 200+ is fine.
- For CPU-heavy work, reduce to 50-100 to avoid action timeouts.

### `CLAIM_LIMIT` (default: 800)

Max tasks read from the task queue per poll. Since `claimTasks` is a read-only
query, reading more tasks doesn't cause OCC. A high value ensures executors
don't miss tasks that appeared since the last poll.

**When to adjust:**
- Rarely needs changing. 800 is high enough to cover most scenarios.
- If you have 1000+ tasks per shard per step, consider increasing to 1500+.

### `FLUSH_BATCH_SIZE` (default: 50)

Max step results sent per `recordResultBatch` mutation call. Each batch is a
single mutation that atomically records results + deletes tasks from the queue.

**Tradeoffs:**
- Larger batches = fewer mutations but heavier per-mutation (more DB reads/writes).
- Smaller batches = more mutations but each is lighter, reducing OCC risk.
- At 50, each batch touches ~50 step documents + ~50 task queue documents +
  workflow lookups = ~200 DB operations.

### `FLUSH_INTERVAL_MS` (default: 500)

How often the background flush loop sends pending results to the database.
Results accumulate in memory between flushes.

**Tradeoffs:**
- Lower = faster step transitions (next step starts sooner after completion),
  but more mutation pressure.
- Higher = fewer mutations but higher latency between step completion and
  the next step becoming available.
- For latency-sensitive workflows (short steps), try 200-300ms.
- For throughput-oriented workflows (many long steps), 500-1000ms is fine.

### `POLL_BACKOFF_MS` (default: 500) / `POLL_BACKOFF_ACTIVE_MS` (default: 150)

Sleep duration between `claimTasks` polls. Two values:
- `POLL_BACKOFF_MS`: Used when no tasks were claimed (idle polling).
- `POLL_BACKOFF_ACTIVE_MS`: Used when tasks are actively running (responsive
  polling for new work).

**When to adjust:**
- For very short steps (<1s), reduce `POLL_BACKOFF_ACTIVE_MS` to 50-100ms
  so new steps are picked up immediately.
- For long steps (10s+), the defaults are fine — tasks don't arrive fast
  enough to warrant faster polling.

### `RESCHEDULE_MS` (default: 8 minutes)

How long an executor runs before scheduling its replacement. Convex actions
have a 10-minute hard timeout, so this must be less than 10 minutes. The
handoff protocol ensures zero-gap continuity between old and new executors.

**When to adjust:**
- Increase to 9 minutes if you want fewer handoffs (less overhead), but
  leave at least 60 seconds of margin for the handoff protocol.
- Decrease if your action is doing heavy per-task work and you want more
  frequent memory cleanup.

## Per-Step Retry Configuration

Individual steps can specify retry behavior:

```typescript
const result = await step.runAction(internal.myModule.myAction, {
  input: "data",
}, {
  retry: {
    maxAttempts: 5,
    initialBackoffMs: 1000,
    base: 2,  // exponential backoff multiplier
  },
});
```

The executor retries failed steps in-process with exponential backoff:
`delay = initialBackoffMs * base^attempt`. For example, with the defaults
above: 1s, 2s, 4s, 8s, 16s.

**For external API calls** (LLM, HTTP, etc.): Set `maxAttempts: 3-5` with
`initialBackoffMs: 1000`. The external service's SDK may also have its own
retry logic — be aware of retry amplification.

## Tuning Profiles

### Fast, Short Steps (e.g., database lookups, transformations)

Steps complete in <1 second. The bottleneck is step transition latency
(time between one step completing and the next step starting).

```typescript
// Constructor
const workflow = new WorkflowManager(components.workflow, {
  executorShards: 40,
  workpoolOptions: { maxParallelism: 500 },
});

// Internal constants to tune:
// FLUSH_INTERVAL_MS = 200    — flush results faster
// POLL_BACKOFF_ACTIVE_MS = 50 — poll for new tasks more aggressively
// MAX_CONCURRENCY = 300       — more concurrent handlers since they're short
// FLUSH_BATCH_SIZE = 30       — smaller batches, flush more often
```

**Key concern:** Mutation throughput. Many short steps = many mutations/sec.
Keep shard count moderate (40-60) to avoid overwhelming Convex's mutation
queue. Monitor for "too many concurrent commits" errors.

### LLM API Calls (1-10s per step, rate-limited)

Steps are network-bound with high variance. Some complete in 1s, others take
30s+ due to rate limiting and retries.

```typescript
// Constructor
const workflow = new WorkflowManager(components.workflow, {
  executorShards: 100,
  workpoolOptions: { maxParallelism: 200 },
});

// Internal constants to tune:
// MAX_CONCURRENCY = 200      — enough to keep API saturated
// FLUSH_INTERVAL_MS = 500    — default is fine, steps are slow enough
// FLUSH_BATCH_SIZE = 50      — default is fine
// POLL_BACKOFF_ACTIVE_MS = 150 — default is fine
```

**Key concerns:**
- **Rate limiting**: Your LLM SDK should handle 429 retries internally (e.g.,
  Anthropic SDK's `maxRetries`). Don't also retry at the workflow level unless
  the SDK gives up entirely.
- **Concurrency**: `MAX_CONCURRENCY × executorShards` = total concurrent API
  calls. At 200 × 100 = 20,000 concurrent calls, you'll hit any API's rate
  limit. The SDK's retry logic absorbs this, but step durations become highly
  variable.
- **Failures**: If your rate limit budget can't sustain the concurrency, steps
  will fail after exhausting retries. Either reduce `MAX_CONCURRENCY` or
  increase the SDK's `maxRetries`.

### Long-Running Steps (30s-5min per step)

Steps do heavy computation or wait on slow external services.

```typescript
// Constructor
const workflow = new WorkflowManager(components.workflow, {
  executorShards: 20,
  workpoolOptions: { maxParallelism: 100 },
});

// Internal constants to tune:
// MAX_CONCURRENCY = 50       — fewer concurrent since each is heavy
// FLUSH_INTERVAL_MS = 1000   — no rush, steps are slow
// POLL_BACKOFF_MS = 1000     — poll less often when idle
// CLAIM_LIMIT = 200          — fewer tasks per shard at any time
```

**Key concern:** Action timeout. Convex actions have a 10-minute hard limit.
If a single step takes >8 minutes, it won't complete before the executor
reschedules. Keep individual steps under 5 minutes.

### High Volume, Bursty Workloads (20k+ workflows created at once)

Large batches of workflows created simultaneously. The mutation queue becomes
the bottleneck as batch creation competes with step execution.

```typescript
// Constructor
const workflow = new WorkflowManager(components.workflow, {
  executorShards: 100,
  workpoolOptions: { maxParallelism: 200 },
});
```

**Key concerns:**
- **Batch creation starvation**: When 100 shards are all flushing results and
  triggering replays, workflow creation mutations get crowded out. Later
  batches of workflows take progressively longer to be created.
- **"Too many concurrent commits"**: At peak load, 100 shards each firing
  `recordResultBatch` + multiple `replayIfReady` mutations = 200-600
  concurrent mutations. Some will fail and retry. This is expected and
  handled — the system self-heals.
- **Not a problem in practice**: Bursty creation is a benchmark artifact.
  Production workloads typically create workflows over time, not 20k at once.
  The mutation contention during step execution doesn't affect steady-state
  throughput.

## Monitoring and Diagnosis

### Key metrics to watch

1. **"Too many concurrent commits" errors in Convex logs**: Indicates mutation
   throughput saturation. Reduce shard count or increase `FLUSH_INTERVAL_MS`.

2. **Task queue depth** (`diagnose` query): If tasks pile up, executors can't
   keep up. Increase `MAX_CONCURRENCY` or shard count.

3. **Step transition latency** (`diagnoseTail` action): The `interStepGap`
   stat shows time between one step completing and the next starting. High
   p90/p99 values indicate flush or polling delays.

4. **Queue wait time** (`diagnoseTail`): The `queueWait` stat shows time
   between a task being enqueued and an executor starting it. High values
   indicate not enough executors or too-slow polling.

### Benchmark viz

The benchmark viz (`/benchmark-viz?after=<timestamp>`) renders a timeline
of all workflows as a staircase chart:

- **Tight staircase**: Good — batches are created and executed smoothly.
- **Growing gaps between batches**: Batch creation starvation (mutation queue
  pressure from step execution).
- **Wide step bars**: Steps taking longer than expected (rate limiting, slow
  external services, or high queue wait time).
- **Flat sections**: No new workflows being created — executors are idle
  or creation is stalled.

## Summary: What to Tune First

1. **`executorShards`** — Most impactful. Start with `count / 200` and adjust.
2. **`MAX_CONCURRENCY`** — Match to your step's resource profile. 200 for
   network-bound, 50 for CPU-bound.
3. **`FLUSH_INTERVAL_MS`** — Only tune for very short steps (<1s).
4. **Everything else** — Defaults work well for most workloads. Only adjust
   if benchmarks reveal a specific bottleneck.
