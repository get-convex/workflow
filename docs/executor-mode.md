# Executor Mode: Sharded Task Queue for High-Throughput Workflows

## Problem

At scale (10K+ concurrent workflows), BatchWorkpool hits a severe OCC bottleneck.
Every worker contends on a single `batchConfig` document for task coordination,
causing ~60K contested writes at 10K scale. Result: **725 seconds** for 10K
4-step workflows.

## Solution: Sharded Task Queue + Executor-Driven Chaining

Replace the single-document coordination with a sharded task queue inside the
workflow component. Each executor action reads from a non-overlapping shard
index range, eliminating cross-executor OCC contention entirely.

**Result: 10K 4-step workflows complete in ~120 seconds with 0 failures (6x improvement).**

## Architecture

```
workflow.start() --> coordinator --> workflow replay --> startSteps
                                                            |
                                          inserts task into taskQueue (shard = random)
                                                            |
                    +---------------------------------------+
                    |                                       |
executor(shard=0)   executor(shard=1)   ...   executor(shard=N)
     |                   |                         |
claimTasks(shard=0) claimTasks(shard=1)        claimTasks(shard=N)
     |                   |                         |
  run handler         run handler              run handler
     |                   |                         |
recordResult         recordResult              recordResult
  (atomic:             (atomic:                  (atomic:
   record step result   record step result        record step result
   + delete task        + delete task             + delete task
   + replay workflow    + replay workflow          + replay workflow
   + insert new tasks)  + insert new tasks)       + insert new tasks)
```

Key: Each executor only queries `taskQueue.withIndex("by_shard", q => q.eq("shard", N))`.
Non-overlapping index ranges = no OCC conflicts between executors.

## Critical Design Decisions

### 1. Atomic task lifecycle (most important)

The task queue entry is **not** deleted when the executor claims it. Instead,
`claimTasks` reads tasks without deleting them. The `recordResult` mutation
atomically:

1. Records the step result (marks step as completed)
2. Deletes the task from the queue (via `by_stepId` index lookup)
3. Replays the workflow inline if this was the last in-progress step
4. The replay may insert new tasks into the queue

This ensures that if the executor action dies mid-processing, the task is still
in the queue and can be picked up by a restarted executor. With the old design
(delete-on-claim), a crash between claiming and recording would permanently
lose the task.

```
                 OLD (broken)                       NEW (correct)
                 ============                       =============
claimTasks:      DELETE task         claimTasks:     READ task (no delete)
                   |                                   |
executor:        run handler         executor:       run handler
                   |                                   |
recordResult:    record result       recordResult:   record result
                                                     + DELETE task  <-- atomic!
                                                     + replay workflow

If executor dies here ^                If executor dies here ^
--> task is gone, step stuck forever   --> task still in queue, reclaimable
```

### 2. Separated claiming from result recording

The original combined `recordResultAndClaim` tried to claim new tasks from the
shard inside the same mutation that recorded the result. This caused massive OCC:
50 concurrent `recordResult` mutations per shard all querying the same index
range for claiming. Separating them eliminates this contention.

The executor's main loop now: **claim batch -> process all -> wait idle -> claim again**.

### 3. Inline workflow replay

When `recordResult` detects that all in-progress steps for a workflow have
completed, it replays the workflow mutation inline (via `ctx.runMutation`).
This means new steps are created in the same transaction, and their tasks
appear in the queue immediately for the next claim cycle.

### 4. Random shard assignment

Tasks are assigned to shards via `Math.floor(Math.random() * numShards)`.
At 10K scale with 20 shards, this gives ~500 tasks per shard per step,
which distributes load evenly.

## Files Changed

| File | Change |
|------|--------|
| `src/component/schema.ts` | Added `taskQueue` table with `by_shard` and `by_stepId` indexes. Added `executorShards` field on workflow document. |
| `src/component/taskQueue.ts` | **NEW.** Three mutations: `claimTasks` (read-only claim), `recordResult` (atomic record + delete + replay), `startExecutors` (schedules executor actions). |
| `src/component/journal.ts` | Modified `startSteps` to route action steps through `taskQueue` when `workflow.executorShards` is set. |
| `src/component/workflow.ts` | Passes `executorShards` through workflow creation. Updated cancel handler to handle executor-style workIds (`executor:stepId`). |
| `src/client/index.ts` | Added `executor()`, `setExecutorRef()`, `startExecutors()` methods. Modified `action()` to store handlers in-memory for executor mode. |
| `src/component/_generated/api.ts` | Added `taskQueue` module. |
| `src/component/_generated/component.ts` | Added `taskQueue` section to ComponentApi type. |

## User-Facing API

### Setup (executor mode)

```typescript
import { WorkflowManager } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api.js";

const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: { maxParallelism: 200 },
  executorShards: 20,  // Number of executor shards
});

// Register actions that run inside executors (not as separate Convex actions)
export const myAction = workflow.action("myAction", {
  args: { input: v.string() },
  handler: async (ctx, { input }) => {
    // This runs inside the long-lived executor action
    return await doWork(input);
  },
});

// Define workflows that use those actions
export const myWorkflow = workflow.define({
  args: { data: v.string() },
  handler: async (step, args) => {
    const result = await step.runAction(internal.myModule.myAction, {
      input: args.data,
    });
    return { result };
  },
});

// Create and export the executor action
export const executorAction = workflow.executor();
workflow.setExecutorRef(internal.myModule.executorAction);
```

### Setup (old BatchWorkpool mode for comparison)

```typescript
import { WorkflowManager } from "@convex-dev/workflow";
import { BatchWorkpool } from "@convex-dev/workpool";

const batch = new BatchWorkpool(components.workpool, {
  maxWorkers: 20,
  maxConcurrencyPerWorker: 1000,
});
export const batchExecutor = batch.executor();
batch.setExecutorRef(internal.myModule.batchExecutor);

const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: { maxParallelism: 200 },
  batch,
});

export const batchBridge = workflow.batchBridge();
workflow.setBatchBridgeRef(internal.myModule.batchBridge);

export const myAction = workflow.action("myAction", { ... });
```

The executor mode is simpler: no separate `BatchWorkpool` instance, no
`batchBridge`/`setBatchBridgeRef`, no workpool component dependency.

### Starting workflows

```typescript
// From a mutation:
await workflow.start(ctx, internal.myModule.myWorkflow, { data: "hello" });

// Async start (coordinator handles scheduling):
await workflow.start(ctx, internal.myModule.myWorkflow, { data: "hello" }, {
  startAsync: true,
});

// Manually start executors (if not using startAsync from a mutation):
await workflow.startExecutors(ctx);
```

## Executor Action Internals

Each executor is a long-running Convex action assigned to a single shard.
Key constants:

| Constant | Value | Purpose |
|----------|-------|---------|
| `CLAIM_LIMIT` | 100 | Max tasks claimed per round |
| `MAX_CONCURRENCY` | 500 | Max concurrent task handlers per executor |
| `POLL_BACKOFF_MS` | 2000 | Backoff between empty polls |
| `MAX_EMPTY_POLLS` | 60 | ~2 min idle before terminating |
| `RESCHEDULE_MS` | 8 min | Self-reschedule before 10-min action timeout |

**Executor loop:**
1. Call `claimTasks(shard, limit=100)` — reads (not deletes) tasks
2. Feed all claimed tasks to a bounded-concurrency pool
3. Each task: run handler -> call `recordResult` mutation
4. Wait for pool to drain (`waitUntilIdle`)
5. Loop back to step 1 (next claim sees only new/undeleted tasks)
6. If no tasks and nothing in-flight, back off and poll
7. After ~2 min idle, terminate
8. After ~8 min runtime, self-reschedule to avoid action timeout

## Benchmark Results

**Workload:** N workflows, each with 4 steps (extract -> analyze-a + analyze-b
in parallel -> summarize). Each step simulates ~5s of work.

| Scale | BatchWorkpool | Executor (20 shards) | Speedup |
|-------|--------------|---------------------|---------|
| 20    | N/A          | <30s, 0 failures    | -       |
| 100   | ~88s         | <45s, 0 failures    | ~2x     |
| 1000  | N/A          | <45s, 0 failures    | -       |
| 10000 | 725s         | ~120s, 0 failures   | **6x**  |

## Known Limitations / Future Work

1. **No automatic crash recovery.** If an executor dies mid-processing, tasks
   remain in the queue (correct), but no mechanism automatically restarts
   executors. The `startExecutors` method must be called manually or from a
   cron. Consider adding a watchdog.

2. **Coordinator dependency for startAsync.** When using `startAsync: true`,
   the coordinator processes workflows in batches of 500. At 10K+ scale, some
   `runWorkflowBatch` mutations may fail silently due to transaction limits,
   leaving workflows unprocessed. Using inline start (no `startAsync`) avoids
   this but is slower per-creation.

3. **BatchWorkpool still exists as a separate path.** The executor mode is a
   parallel implementation, not a replacement. Consider consolidating: make the
   executor mode the implementation behind the existing `batch` API, removing
   the BatchWorkpool dependency entirely.

4. **Shard count is static.** The number of shards is set at workflow creation
   time and stored on each workflow document. Changing it requires creating new
   workflows. Consider making it configurable at the executor level.

5. **claimTasks uses a mutation (not a query).** Even though it only reads,
   it's a mutation to ensure consistent reads. This could potentially be
   optimized.

## How to Test

### Prerequisites

1. A Convex deployment. The benchmark uses `dev:prestigious-duck-166` (stored
   in `example/.env.local`). You can use any deployment.
2. Build the component source and deploy:

```bash
npm run build
cd example && npx convex dev --once
```

### Running a benchmark

All benchmark functions are internal mutations/queries in `example/convex/benchmark.ts`.
Use the Convex dashboard or CLI to invoke them.

#### 1. Start workflows

```bash
# Executor mode, 100 workflows
npx convex run benchmark:startBenchmark '{"mode": "executor", "count": 100}'

# Executor mode, 1000 workflows
npx convex run benchmark:startBenchmark '{"mode": "executor", "count": 1000}'

# Executor mode, 10000 workflows
npx convex run benchmark:startBenchmark '{"mode": "executor", "count": 10000}'

# Batched mode (BatchWorkpool baseline), 100 workflows
npx convex run benchmark:startBenchmark '{"mode": "batched", "count": 100}'
```

`startBenchmark` is a mutation that:
- Schedules batch creation mutations (500 workflows each) via `ctx.scheduler.runAfter(0)`
- Starts executor actions (one per shard) if mode is `"executor"`
- Returns immediately with `{ startedAt }` timestamp

#### 2. Monitor progress

```bash
# For executor mode:
npx convex run benchmark:benchmarkStatus \
  '{"name": "benchmark:executorResearchWorkflow", "expectedCount": 1000}'

# For batched mode:
npx convex run benchmark:benchmarkStatus \
  '{"name": "benchmark:batchedResearchWorkflow", "expectedCount": 100}'
```

Returns `{ total, completed, failed, running }`. Poll every 10-30 seconds
until `running` reaches 0.

#### 3. Diagnose issues (executor mode)

```bash
npx convex run benchmark:diagnoseExecutor
```

Returns:
- `taskQueueCounts`: tasks remaining per shard
- `totalTasks`: total tasks in queue
- `stuckWorkflows`: workflows with `executorShards` set, no `runResult`, and no in-progress steps
- `workflowsWithNoSteps`: subset of stuck workflows that never had any steps created

If stuck workflows > 0 and totalTasks = 0, executors may have died. Restart:

```bash
npx convex run benchmark:startExecutors
```

#### 4. Cleanup after a run

```bash
# Cancel any still-running workflows
npx convex run benchmark:cancelBatch \
  '{"name": "benchmark:executorResearchWorkflow", "limit": 1000}'

# Delete completed/canceled workflow data
npx convex run benchmark:cleanupOldest \
  '{"name": "benchmark:executorResearchWorkflow", "limit": 1000}'
```

Run cleanup repeatedly until all workflows are removed. Important: accumulated
workflow data from prior runs can cause `benchmarkStatus` queries to hit
Convex's 32K document read limit.

### What a successful run looks like

- `startBenchmark` returns in < 3 seconds
- `benchmarkStatus` shows `running` count increasing, then `completed` climbing
- Final status: `completed` = count, `failed` = 0, `running` = 0
- `diagnoseExecutor` shows `totalTasks: 0`, `stuckWorkflows: 0`

## Scaling Estimates

### Observed performance (20 shards, ~5s simulated work per step)

| Scale | Wall-clock time | Tasks/shard/step | Notes |
|-------|----------------|------------------|-------|
| 20    | < 30s          | 1                | Trivial load |
| 100   | < 45s          | 5                | Well within capacity |
| 1000  | < 45s          | 50               | Comfortable |
| 10000 | ~120s          | 500              | At comfortable capacity |

### Bottleneck analysis

The system has three main scaling dimensions:

1. **Creation throughput**: `startBenchmark` schedules batch-creation mutations
   (500 workflows each) via `runAfter(0)`. Each mutation runs independently.
   At 10K, this means 20 mutations running concurrently — well within limits.
   At 100K, it's 200 mutations, which may face some queueing but should work.

2. **Executor throughput**: Each executor processes up to `MAX_CONCURRENCY=500`
   tasks concurrently. With 20 shards, that's 10,000 concurrent task handlers.
   Each step takes ~5s of simulated work + mutation overhead (~100ms). A single
   shard processes ~100 tasks/second throughput (500 concurrent / 5s per task).
   Total cluster: ~2,000 tasks/second.

3. **Mutation throughput**: Every task completion triggers a `recordResult`
   mutation. At peak, 20 shards × 500 concurrent = potentially 10K mutations
   in flight. Convex can handle this since each mutation touches different
   documents (no OCC contention across shards).

4. **Coordinator throughput** (for `startAsync` creation): Processes 500
   workflows per coordinator pass, with `runWorkflowBatch` mutations of 100
   each. At 10K, the coordinator needs ~20 passes. At 100K, it needs ~200
   passes. Some `runWorkflowBatch` mutations may fail at very high scale.

### Projections

**20K workflows (4 steps each, ~5s simulated work)**

| Config | Estimated time | Rationale |
|--------|---------------|-----------|
| 20 shards | ~180-240s | 1000 tasks/shard/step. Each shard runs 500 concurrently, needs 2 rounds per step. 4 steps × ~2 rounds × ~15s/round ≈ 120s execution + ~60-120s creation/coordinator overhead. |
| 40 shards | ~120-150s | 500 tasks/shard/step (same as 10K@20 shards). Doubles executor parallelism. May need to increase Convex's concurrent action limit. |

**100K workflows (4 steps each, ~5s simulated work)**

| Config | Estimated time | Rationale |
|--------|---------------|-----------|
| 20 shards | ~15-20 min | 5000 tasks/shard/step. Each shard needs 10 claim rounds per step. Bottleneck shifts to creation throughput and coordinator. |
| 100 shards | ~3-5 min | 1000 tasks/shard/step. 100 concurrent executor actions (within Convex's 512 action limit). Main bottleneck becomes creation and coordinator throughput. |
| 100 shards + inline start | ~2-4 min | Skip coordinator entirely. Creation is slower per-workflow but more reliable. Need to batch `start()` calls across multiple mutations. |

### Recommendations for 20K+

1. **Increase shard count proportionally**: Keep tasks-per-shard around 500 for
   optimal performance. 20K → 40 shards, 100K → 200 shards (but see action
   limit below).

2. **Watch the concurrent action limit**: Convex allows 512 concurrent actions
   per deployment. Each shard is one action. At 200 shards, that's 200/512
   actions consumed by executors, leaving 312 for other work.

3. **Skip the coordinator at high scale**: Use inline start (no `startAsync`)
   to avoid coordinator bottlenecks. Batch creation across multiple scheduled
   mutations (as `startBenchmark` already does).

4. **Increase `MAX_EMPTY_POLLS`**: At very high scale, creation may take minutes.
   Executors need to stay alive long enough. Current value (60 polls × 2s = 2
   min idle timeout) works for 10K. For 100K, consider 120+ polls.

5. **Consider shard rebalancing**: Random shard assignment gives ±5% variance
   at 500 tasks/shard. At 5000 tasks/shard the variance shrinks proportionally,
   but outlier shards can still cause tail latency.
